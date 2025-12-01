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
            subject: '',
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
                // Handle folded header lines
                while ((i + 1 < lines.length) && regex.test(lines[i + 1])) {
                    analysis.sender += ' ' + lines[i + 1].trim();
                    i++;
                }
            } else if (line.startsWith('subject:')) {
                analysis.subject = originalLine.substring(8).trim();
                while ((i + 1 < lines.length) && regex.test(lines[i + 1])) {
                    analysis.subject += ' ' + lines[i + 1].trim();
                    i++;
                }
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
        if (!(analysis && analysis.sender)) return;
        const secEl = document.getElementById('security-score');
        const valEl = document.getElementById('score-value');
        const badgeEl = document.getElementById('score-badge');
        const authEl = document.getElementById('score-auth');
        const contEl = document.getElementById('score-content');
        const bar = document.getElementById('ring-progress');
        const authScore = this.computeAuthScore(analysis);
        const contentScore = this.mapContentScore(analysis.aiClassification);
        const score = Math.max(0, Math.min(100, authScore + contentScore));
        secEl.style.display = 'grid';
        valEl.textContent = String(score);
        badgeEl.textContent = (analysis.aiClassification || 'Normal').toUpperCase();
        badgeEl.classList.remove('warn','danger','harass');
        const badgeTone = this.classTone(analysis.aiClassification);
        if (badgeTone === 'warn') badgeEl.classList.add('warn');
        if (badgeTone === 'danger') badgeEl.classList.add('danger');
        if (badgeTone === 'harass') badgeEl.classList.add('harass');
        authEl.textContent = `${authScore}/60`;
        contEl.textContent = `${contentScore}/40`;
        if (bar) {
            const p = Math.max(0, Math.min(100, score));
            bar.style.strokeDashoffset = String(100 - p);
            const strokeId = p > 60 ? 'ringGradient' : (p > 40 ? 'ringGradientAmber' : 'ringGradientRed');
            bar.style.stroke = `url(#${strokeId})`;
        }

        const idEl = document.getElementById('identity-section');
        idEl.style.display = 'grid';
        document.getElementById('identity-from').textContent = this.escapeHtml(this.formatSender(analysis.sender) || '');
        const subj = (analysis.subject && String(analysis.subject).trim()) ? analysis.subject : 'No Subject';
        document.getElementById('identity-subject').textContent = this.escapeHtml(subj);

        const tableEl = document.getElementById('auth-table');
        tableEl.style.display = 'grid';
        this.setAuthRow('auth-row-spf', analysis.spf);
        this.renderAuthExplain('spf', analysis.spf);
        this.setAuthRow('auth-row-dkim', analysis.dkim);
        this.renderAuthExplain('dkim', analysis.dkim);
        this.setAuthRow('auth-row-dmarc', analysis.dmarc);
        this.renderAuthExplain('dmarc', analysis.dmarc);

        this.updateAIAnalysis(analysis);
        this.updateOverallVerdict(analysis);
        const cta = document.getElementById('cta');
        cta.style.display = 'flex';
    }

    updateAIAnalysis(analysis) {
        const card = document.getElementById('ai-card');
        const cls = document.getElementById('ai-classification');
        const pts = document.getElementById('ai-points');
        if (!card || !cls || !pts) return;
        const label = (analysis.aiClassification || '').trim();
        if (label) {
            card.style.display = 'grid';
            cls.textContent = `Classification: ${label}`;
            cls.classList.remove('warn','danger','harass');
            const tone = this.classTone(label);
            if (tone === 'warn') cls.classList.add('warn');
            if (tone === 'danger') cls.classList.add('danger');
            if (tone === 'harass') cls.classList.add('harass');
            card.classList.remove('secure','warn','danger','harass');
            if (tone === 'normal') card.classList.add('secure');
            if (tone === 'warn') card.classList.add('warn');
            if (tone === 'danger') card.classList.add('danger');
            // Do not color the entire AI card for harassment; keep it neutral
            const p = analysis.aiProbabilities || {};
            const bullets = this.mapBullets(label, p).slice(0, 3);
            pts.innerHTML = bullets.map(x => `<li>${this.escapeHtml(x)}</li>`).join('');
        } else {
            card.style.display = 'grid';
            card.classList.remove('secure','warn','danger','harass');
            cls.classList.remove('warn','danger','harass');
            cls.textContent = 'Classification: Analysis Available';
            const bullets = this.mapBullets('suspicious', {}).slice(0,3);
            pts.innerHTML = bullets.map(x => `<li>${this.escapeHtml(x)}</li>`).join('');
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
        verdictElement.classList.remove('secure', 'warning', 'danger', 'harass');
        iconElement.classList.remove('secure', 'warning', 'danger', 'harass');

        let verdictClass, title, message;
        const cls = (analysis.aiClassification || '').toLowerCase();
        if (cls === 'normal') { verdictClass = 'secure'; title = 'Safe to Interact'; message = 'This email appears legitimate and safe. All checks passed.'; }
        else if (cls === 'fraudulent') { verdictClass = 'danger'; title = 'High Risk - Fraudulent'; message = 'Do not engage. Authentication checks or content indicate fraud.'; }
        else if (cls.includes('harass')) { verdictClass = 'harass'; title = 'Harassment Content'; message = 'Exercise caution. Content indicates harassment.'; }
        else if (cls === 'suspicious') { verdictClass = 'warning'; title = 'Suspicious Content'; message = 'Be cautious. Content indicates suspicious patterns.'; }
        else { verdictClass = 'warning'; title = 'Analysis Available'; message = 'Authentication results shown below.'; }

        verdictElement.classList.add(verdictClass);
        iconElement.classList.add(verdictClass);
        titleElement.textContent = title;
        messageElement.textContent = message;

        verdictElement.classList.add('fade-in');

        const safeCard = document.getElementById('safe-card');
        const safeText = document.getElementById('safe-text');
        if (cls === 'normal') { safeCard.style.display = 'grid'; safeText.textContent = 'This email appears legitimate and safe. All security checks passed with high confidence.'; }
        else { safeCard.style.display = 'none'; safeText.textContent = ''; }
    }

    setAuthRow(id, data) {
        const el = document.getElementById(id);
        const status = (typeof data === 'string')
            ? data.toLowerCase()
            : ((data && data.status) ? String(data.status).toLowerCase() : 'unknown');
        if (status === 'pass') { el.textContent = 'PASS'; el.className = 'auth-pass'; }
        else if (status === 'fail') { el.textContent = 'FAIL'; el.className = 'auth-fail'; }
        else if (status === 'softfail' || status === 'neutral' || status === 'none' || status === 'present' || status === 'unknown') { el.textContent = status.toUpperCase(); el.className = 'auth-warn'; }
        else { el.textContent = status.toUpperCase(); el.className = ''; }
    }

    computeAuthScore(analysis) {
        const scoreFor = (s) => {
            const st = (s || '').toLowerCase();
            if (st === 'pass') return 20;
            if (st === 'softfail' || st === 'neutral' || st === 'present') return 10;
            return 0;
        };
        const spf = scoreFor(analysis?.spf?.status);
        const dkim = scoreFor(analysis?.dkim?.status);
        const dmarc = scoreFor(analysis?.dmarc?.status);
        return Math.max(0, Math.min(60, spf + dkim + dmarc));
    }

    mapContentScore(label) {
        const l = (label || '').toLowerCase();
        if (l === 'normal') return 40;
        if (l === 'suspicious') return 20;
        if (l.includes('harass') || l.includes('harras')) return 10;
        if (l === 'fraudulent') return 0;
        return 20;
    }

    mapBullets(label, probs) {
        const l = (label || '').toLowerCase();
        if (l === 'normal') return ['Professional language and tone', 'No suspicious links or attachments', 'Known sender domain with good reputation', 'No urgency or pressure tactics', 'Standard business communication patterns'];
        if (l === 'fraudulent') return ['Deceptive or coercive language', 'Potential phishing indicators', 'Unknown or mismatched sender identity', 'Urgency and pressure tactics', 'Request for sensitive information or payment'];
        if (l.includes('harass') || l.includes('harras')) return ['Aggressive or abusive tone', 'Targeted harassment indicators', 'Potential policy violations', 'Consider reporting or blocking'];
        return ['Ambiguous content patterns', 'Be cautious with links or attachments', 'Verify sender identity before action'];
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

    renderAuthExplain(type, data) {
        const status = (typeof data === 'string') ? data : (data && data.status || 'unknown');
        const toggleButton = document.getElementById(`${type}-explain-toggle`);
        const explainPanel = document.getElementById(`${type}-explain`);
        if (!toggleButton || !explainPanel) return;

        const explanation = typeof data === 'object' ? (data.explain || data.explanation || '') : '';
        const details = typeof data === 'object' ? (data.details || '') : '';
        const isUnknown = ['unknown', 'none', 'missing'].includes(String(status || '').toLowerCase());
        const needsFallback = isUnknown && !explanation && !details;

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
        const finalDetailsHtml = details ? `<div>${this.escapeHtml(details)}</div>` : fallbackDetailsHtml;

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

    extractDomain(email) {
        if (!email) return null;
        const match = email.match(/@([^>\s]+)/);
        return match ? match[1] : null;
    }

    formatSender(sender) {
        if (!sender) return '';
        const emailMatch = sender.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
        return emailMatch ? emailMatch[0] : sender;
    }

    classTone(label) {
        const l = (label || '').toLowerCase();
        if (l === 'fraudulent') return 'danger';
        if (l.includes('harass') || l.includes('harras')) return 'harass';
        if (l === 'suspicious') return 'warn';
        return 'normal';
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