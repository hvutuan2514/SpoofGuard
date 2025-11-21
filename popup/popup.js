/**
 * SpoofGuard - Email Security Analysis Extension
 * Popup Interface Controller
 */

class SpoofGuardPopup {
    constructor() {
        this.currentEmailData = null;
        this.settings = {
            realTimeMonitoring: true,
            showNotifications: true,
            detailedLogging: false
        };
        
        this.init();
    }

    async init() {
        // Removed settings load and UI bindings for deleted controls
        this.setupEventListeners();
        this.updateStatusIndicator();
        await this.checkCurrentEmail();
    }

    setupEventListeners() {
        // Manual header analysis and settings toggles have been removed.
        // Intentionally left empty to avoid null addEventListener errors.
    }

    updateStatusIndicator() {
        const statusDot = document.getElementById('status-dot');
        const statusText = document.getElementById('status-text');
        
        if (statusDot) statusDot.style.background = '#27ae60';
        if (statusText) statusText.textContent = 'Monitoring';
    }

    async loadSettings() {
        try {
            const result = await chrome.storage.sync.get(['spoofGuardSettings']);
            if (result.spoofGuardSettings) {
                this.settings = { ...this.settings, ...result.spoofGuardSettings };
            }
            this.applySettings();
        } catch (error) {
            console.error('Error loading settings:', error);
        }
    }

    applySettings() {
        document.getElementById('real-time-monitoring').checked = this.settings.realTimeMonitoring;
        document.getElementById('show-notifications').checked = this.settings.showNotifications;
        document.getElementById('detailed-logging').checked = this.settings.detailedLogging;
    }

    async updateSetting(key, value) {
        this.settings[key] = value;
        try {
            await chrome.storage.sync.set({ spoofGuardSettings: this.settings });
            
            // Notify content script of settings change
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                chrome.tabs.sendMessage(tab.id, {
                    type: 'SETTINGS_UPDATED',
                    settings: this.settings
                });
            }
        } catch (error) {
            console.error('Error saving settings:', error);
        }
    }

    async checkCurrentEmail() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            if (tab && this.isEmailProvider(tab.url)) {
                try {
                    // First, try to communicate with existing content script
                    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_EMAIL' });
                    
                    if (response && response.sender) {
                        this.displayEmailAnalysis(response);
                        return;
                    }
                } catch (connectionError) {
                    console.log('SpoofGuard: Content script not responding, attempting to inject...');
                    
                    // Try to inject the content script
                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            files: ['content/content.js']
                        });
                        
                        // Wait a moment for the script to initialize
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                        // Try communication again
                        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_EMAIL' });
                        
                        if (response && response.sender) {
                            this.displayEmailAnalysis(response);
                            return;
                        }
                    } catch (injectionError) {
                        console.error('SpoofGuard: Failed to inject content script:', injectionError);
                    }
                }
                
                // If we get here, show debug info
                this.displayEmailAnalysis({
                    url: tab.url,
                    provider: this.getProviderFromUrl(tab.url),
                    sender: null,
                    error: 'Content script communication failed'
                });
            } else {
                this.showError('Please navigate to Gmail or Outlook to analyze emails.');
            }
        } catch (error) {
            console.error('Error checking current email:', error);
            this.showError('Unable to analyze current email. Make sure you have an email open.');
        }
    }

    getProviderFromUrl(url) {
        if (url.includes('mail.google.com')) return 'Gmail';
        if (url.includes('outlook.live.com') || url.includes('outlook.office.com')) return 'Outlook';
        return 'Unknown';
    }

    isEmailProvider(url) {
        const emailProviders = [
            'mail.google.com',
            'outlook.live.com',
            'outlook.office.com',
            'mail.yahoo.com'
        ];
        return emailProviders.some(provider => url.includes(provider));
    }

    analyzeManualHeaders() {
        const headerInput = document.getElementById('header-input');
        const headerText = headerInput.value.trim();
        
        if (!headerText) {
            this.showError('Please paste email headers to analyze.');
            return;
        }

        try {
            const analysis = this.parseEmailHeaders(headerText);
            this.displayEmailAnalysis(analysis);
            
            // Show detailed report for manual analysis
            document.getElementById('detailed-report').style.display = 'block';
            this.updateDetailedReport(analysis);
        } catch (error) {
            this.showError('Error analyzing headers: ' + error.message);
        }
    }

    clearManualAnalysis() {
        document.getElementById('header-input').value = '';
        document.getElementById('auth-results').style.display = 'none';
        document.getElementById('overall-verdict').style.display = 'none';
        document.getElementById('detailed-report').style.display = 'none';
        
        const emailInfo = document.getElementById('email-info');
        emailInfo.innerHTML = '<p class="no-email">No email selected. Open an email to analyze.</p>';
    }

    parseEmailHeaders(headerText) {
        const analysis = {
            spf: { status: 'missing', details: '' },
            dkim: { status: 'missing', details: '' },
            dmarc: { status: 'missing', details: '' },
            sender: '',
            returnPath: '',
            receivedFrom: '',
            messageId: '',
            timestamp: '',
            rawHeaders: headerText
        };

        const lines = headerText.split(/\r?\n/);
        const authBlocks = [];
        const regex = /^\s/;

        // Extract basic email information
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].toLowerCase();
            const originalLine = lines[i];

            // Extract sender information
            if (line.startsWith('from:')) {
                analysis.sender = originalLine.substring(5).trim();
            } else if (line.startsWith('return-path:')) {
                analysis.returnPath = originalLine.substring(12).trim();
            } else if (line.startsWith('message-id:')) {
                analysis.messageId = originalLine.substring(11).trim();
            } else if (line.startsWith('date:')) {
                analysis.timestamp = originalLine.substring(5).trim();
            }

            // Find authentication results
            if (line.startsWith('authentication-results') || line.startsWith('arc-authentication-results')) {
                let block = lines[i];
                // Collect continuation lines
                while ((i + 1 < lines.length) && regex.test(lines[i + 1])) {
                    block += ' ' + lines[i + 1].trim();
                    i++;
                }
                authBlocks.push(block.toLowerCase());
            }
        }

        // Parse authentication results
        if (authBlocks.length > 0) {
            const authLine = authBlocks[0];
            
            // Parse SPF
            const spfMatch = authLine.match(/spf=(\w+)(?:\s+\(([^)]+)\))?/);
            if (spfMatch) {
                analysis.spf.status = spfMatch[1];
                analysis.spf.details = spfMatch[2] || '';
            }

            // Parse DKIM
            const dkimMatch = authLine.match(/dkim=(\w+)(?:\s+\(([^)]+)\))?/);
            if (dkimMatch) {
                analysis.dkim.status = dkimMatch[1];
                analysis.dkim.details = dkimMatch[2] || '';
            }

            // Parse DMARC
            const dmarcMatch = authLine.match(/dmarc=(\w+)(?:\s+\(([^)]+)\))?/);
            if (dmarcMatch) {
                analysis.dmarc.status = dmarcMatch[1];
                analysis.dmarc.details = dmarcMatch[2] || '';
            }
        }

        // Calculate overall security score
        analysis.securityScore = this.calculateSecurityScore(analysis);
        analysis.riskLevel = this.determineRiskLevel(analysis);
        analysis.recommendations = this.generateRecommendations(analysis);

        return analysis;
    }

    calculateSecurityScore(analysis) {
        let score = 0;
        const weights = { spf: 30, dkim: 35, dmarc: 35 };

        ['spf', 'dkim', 'dmarc'].forEach(auth => {
            const status = analysis[auth].status;
            if (status === 'pass') {
                score += weights[auth];
            } else if (status === 'softfail' || status === 'neutral') {
                score += weights[auth] * 0.5;
            }
        });

        return Math.round(score);
    }

    determineRiskLevel(analysis) {
        const score = analysis.securityScore;
        
        if (score >= 80) return 'low';
        if (score >= 50) return 'medium';
        return 'high';
    }

    generateRecommendations(analysis) {
        const recommendations = [];
        
        if (analysis.spf.status === 'fail') {
            recommendations.push('SPF authentication failed - sender may be spoofed');
        }
        if (analysis.dkim.status === 'fail') {
            recommendations.push('DKIM signature invalid - email may be tampered with');
        }
        if (analysis.dmarc.status === 'fail') {
            recommendations.push('DMARC policy violation - high risk of spoofing');
        }
        if (analysis.spf.status === 'missing' && analysis.dkim.status === 'missing') {
            recommendations.push('No authentication mechanisms detected - proceed with extreme caution');
        }

        return recommendations;
    }

    displayEmailAnalysis(analysis) {
        // Update email info
        const emailInfo = document.getElementById('email-info');
        if (analysis && analysis.sender) {
            emailInfo.innerHTML = `
                <strong>From:</strong> ${this.escapeHtml(analysis.sender)}
            `;
            
            const authResults = document.getElementById('auth-results');
            authResults.style.display = 'block';

            // Pass full per-check objects to updateAuthResult
            this.updateAuthResult('spf', analysis.spf || { status: 'unknown' });
            this.updateAuthResult('dkim', analysis.dkim || { status: 'unknown' });
            this.updateAuthResult('dmarc', analysis.dmarc || { status: 'unknown' });

            this.updateAIAnalysis(analysis);
            this.updateOverallVerdict(analysis);
        } else {  
            const authResults = document.getElementById('auth-results');
            if (authResults) {
                authResults.style.display = 'none';
            }
        }
    }

    updateAIAnalysis(analysis) {
        const aiSection = document.getElementById('ai-analysis');
        const aiStatus = document.getElementById('ai-status');
        const aiProbs = document.getElementById('ai-probs');
        if (!aiSection || !aiStatus || !aiProbs) return;
        if (analysis.aiClassification) {
            aiSection.style.display = 'block';
            aiStatus.textContent = analysis.aiClassification.toUpperCase();
            const probs = analysis.aiProbabilities || {};
            const entries = Object.entries(probs).map(([k,v]) => `${k}: ${(v*100).toFixed(1)}%`);
            aiProbs.textContent = entries.join(' | ');
        } else {
            aiSection.style.display = 'none';
            aiStatus.textContent = '-';
            aiProbs.textContent = '';
        }
    }

    updateAuthResult(type, data) {
        const status = (typeof data === 'string') ? data : (data.status || 'unknown');

        const resultElement = document.getElementById(`${type}-result`);
        const statusElement = document.getElementById(`${type}-status`);
        const indicatorElement = document.getElementById(`${type}-indicator`);
        const toggleButton = document.getElementById(`${type}-explain-toggle`);
        const explainPanel = document.getElementById(`${type}-explain`);

        statusElement.textContent = (status || 'unknown').toUpperCase();

        resultElement.classList.remove('pass', 'fail', 'warning');
        if (status === 'pass') {
            resultElement.classList.add('pass');
        } else if (status === 'fail') {
            resultElement.classList.add('fail');
        } else {
            resultElement.classList.add('warning');
        }

        const explanation = typeof data === 'object' ? (data.explain || data.explanation || '') : '';
        const details = typeof data === 'object' ? (data.details || '') : '';

        const isUnknown = ['unknown', 'none', 'missing'].includes((status || '').toLowerCase());
        const needsFallback = isUnknown && !explanation && !details;

        // Fallback reasons for unknown DKIM/DMARC
        let fallbackExplain = '';
        let fallbackDetailsHtml = '';
        if (needsFallback) {
            if (type === 'dkim') {
                fallbackExplain = 'DKIM result is not available for this message.';
                fallbackDetailsHtml = `
                    <ul>
                        <li>No DKIM signature present for the sending domain.</li>
                        <li>Signature present but verification omitted in Authentication-Results.</li>
                        <li>Message was forwarded or sent via a mailing list (ARC may exist).</li>
                        <li>Provider omitted DKIM evaluation for this message.</li>
                    </ul>`;
            } else if (type === 'dmarc') {
                fallbackExplain = 'DMARC result is not available for this message.';
                fallbackDetailsHtml = `
                    <ul>
                        <li>Domain may not publish a DMARC policy or uses p=none.</li>
                        <li>Forwarding or list processing can prevent DMARC recording.</li>
                        <li>Alignment could not be evaluated (missing/non-aligned SPF/DKIM IDs).</li>
                        <li>Provider omitted DMARC evaluation in the headers.</li>
                    </ul>`;
            }
        }

        const finalExplain = explanation || fallbackExplain;
        const finalDetailsHtml = details
            ? `<div>${this.escapeHtml(details)}</div>`
            : fallbackDetailsHtml;

        if (finalExplain || finalDetailsHtml) {
            toggleButton.hidden = false;
            toggleButton.textContent = 'Explain more';
            toggleButton.setAttribute('aria-expanded', 'false');

            explainPanel.classList.remove('expanded');
            explainPanel.setAttribute('aria-hidden', 'true');
            explainPanel.innerHTML = `
                ${finalExplain ? `
                    <div class="explain-section">
                        <div class="explain-title">What this means</div>
                        <div>${this.escapeHtml(finalExplain)}</div>
                    </div>` : ''}
                ${finalDetailsHtml ? `
                    <div class="explain-section">
                        <div class="explain-title">Technical details</div>
                        ${finalDetailsHtml}
                    </div>` : ''}
            `;

            // Toggle using the 'expanded' class for animation
            toggleButton.onclick = () => {
                const expanded = toggleButton.getAttribute('aria-expanded') === 'true';
                const next = !expanded;
                toggleButton.setAttribute('aria-expanded', next ? 'true' : 'false');
                explainPanel.classList.toggle('expanded', next);
                explainPanel.setAttribute('aria-hidden', next ? 'false' : 'true');
            };
        } else {
            toggleButton.hidden = true;
            explainPanel.classList.remove('expanded');
            explainPanel.setAttribute('aria-hidden', 'true');
            explainPanel.innerHTML = '';
        }
    }

    updateOverallVerdict(analysis) {
        const verdictElement = document.getElementById('overall-verdict');
        const iconElement = document.getElementById('verdict-icon');
        const titleElement = document.getElementById('verdict-title');
        const messageElement = document.getElementById('verdict-message');

        verdictElement.style.display = 'flex';
        verdictElement.classList.remove('secure', 'warning', 'danger');
        iconElement.classList.remove('secure', 'warning', 'danger');

        let verdictClass, title, message;
        const cls = (analysis.aiClassification || '').toLowerCase();
        if (cls === 'normal') {
            verdictClass = 'secure';
            title = 'Safe to Interact';
            message = 'AI classification: Normal.';
        } else if (cls === 'fraudulent') {
            verdictClass = 'danger';
            title = 'High Risk - Fraudulent';
            message = 'AI classification: Fraudulent.';
        } else if (cls === 'harassing') {
            verdictClass = 'warning';
            title = 'Harassing Content';
            message = 'AI classification: Harassing.';
        } else if (cls === 'suspicious') {
            verdictClass = 'warning';
            title = 'Suspicious Content';
            message = 'AI classification: Suspicious.';
        } else {
            verdictClass = 'warning';
            title = 'Analysis Available';
            message = 'Authentication results shown below.';
        }

        verdictElement.classList.add(verdictClass);
        iconElement.classList.add(verdictClass);
        titleElement.textContent = title;
        messageElement.textContent = message;

        verdictElement.classList.add('fade-in');
    }

    updateDetailedReport(analysis) {
        document.getElementById('sender-info').textContent = 
            analysis.sender || 'Not available';
        
        document.getElementById('domain-analysis').textContent = 
            this.extractDomain(analysis.sender) || 'Not available';
        
        const authDetails = document.getElementById('auth-details');
        authDetails.innerHTML = `
            <div><strong>SPF:</strong> ${analysis.spf.status} ${analysis.spf.details ? '(' + analysis.spf.details + ')' : ''}</div>
            <div><strong>DKIM:</strong> ${analysis.dkim.status} ${analysis.dkim.details ? '(' + analysis.dkim.details + ')' : ''}</div>
            <div><strong>DMARC:</strong> ${analysis.dmarc.status} ${analysis.dmarc.details ? '(' + analysis.dmarc.details + ')' : ''}</div>
        `;
        
        document.getElementById('risk-assessment').textContent = 
            analysis.recommendations.join('. ') || 'No specific risks identified.';
    }

    extractDomain(email) {
        if (!email) return null;
        const match = email.match(/@([^>\s]+)/);
        return match ? match[1] : null;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showError(message) {
        // Simple error display - could be enhanced with toast notifications
        alert(message);
    }
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SpoofGuardPopup();
});