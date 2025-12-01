/**
 * SpoofGuard Background Service Worker
 * Handles DNS lookups, authentication validation, and extension state management
 */

// Import Gmail API client
import { GmailAPIClient } from './gmail-api.js';

class SpoofGuardBackground {
    constructor() {
        this.emailCache = new Map();
        this.dnsCache = new Map();
        this.gmailAPI = new GmailAPIClient();
        this.settings = {
            realTimeMonitoring: true,
            showNotifications: true,
            detailedLogging: false,
            cacheTimeout: 300000,
            aiServerUrl: 'http://34.75.147.212:8000'
        };
        
        this.init();
    }

    init() {
        try {
            this.setupMessageListeners();
            this.setupAlarms();
            console.log('SpoofGuard: Background service worker initialized');
        } catch (error) {
            console.error('SpoofGuard: Error initializing background service worker:', error);
        }
    }

    setupMessageListeners() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            switch (request.type) {
                case 'EMAIL_ANALYZED':
                    this.handleEmailAnalyzed(request.data);
                    break;
                    
                case 'VALIDATE_HEADERS':
                    this.validateEmailHeaders(request.headers)
                        .then(result => sendResponse(result))
                        .catch(error => sendResponse({ error: error.message }));
                    return true; // Keep message channel open for async response
                    
                case 'DNS_LOOKUP':
                    this.performDNSLookup(request.domain, request.recordType)
                        .then(result => sendResponse(result))
                        .catch(error => sendResponse({ error: error.message }));
                    return true;
                    
                case 'GMAIL_API_AUTH':
                    this.gmailAPI.authenticate()
                        .then(result => sendResponse({ success: result }))
                        .catch(error => sendResponse({ error: error.message }));
                    return true;
                    
                case 'GMAIL_API_HEADERS':
                    this.getGmailHeaders(request.messageId, request.url)
                        .then(result => sendResponse(result))
                        .catch(error => sendResponse({ error: error.message }));
                    return true;
                    
                case 'GET_SETTINGS':
                    chrome.storage.sync.get(['spoofGuardSettings'])
                        .then(result => {
                            const settings = result.spoofGuardSettings || this.settings;
                            sendResponse({ settings });
                        });
                    return true;
                    
                case 'UPDATE_SETTINGS':
                    this.updateSettings(request.settings)
                        .then(() => sendResponse({ success: true }))
                        .catch(error => sendResponse({ error: error.message }));
                    return true;

                case 'CLASSIFY_EMAIL':
                    this.classifyEmailText(request.text)
                        .then(result => sendResponse(result))
                        .catch(error => sendResponse({ error: error.message }));
                    return true;
            }
        });
    }

    setupAlarms() {
        try {
            // Clear cache periodically
            chrome.alarms.create('clearCache', { periodInMinutes: 30 });
            
            chrome.alarms.onAlarm.addListener((alarm) => {
                if (alarm.name === 'clearCache') {
                    this.clearExpiredCache();
                }
            });
            
            console.log('SpoofGuard: Alarms setup completed');
        } catch (error) {
            console.error('SpoofGuard: Error setting up alarms:', error);
        }
    }

    async classifyEmailText(text) {
        try {
            const settings = await chrome.storage.sync.get(['spoofGuardSettings']).then(r => r.spoofGuardSettings || this.settings);
            const url = `${settings.aiServerUrl}/classify`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            if (!response.ok) {
                throw new Error(`Classifier request failed: ${response.status}`);
            }
            const data = await response.json();
            return { success: true, label: data.label, probabilities: data.probabilities };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async handleEmailAnalyzed(emailData) {
        try {
            // Store email data
            this.emailCache.set(emailData.messageId || Date.now(), {
                ...emailData,
                timestamp: Date.now()
            });

            // Perform detailed validation if headers are available
            if (emailData.headers) {
                const validation = await this.validateEmailHeaders(emailData.headers);
                
                // Update email data with validation results
                const updatedData = { ...emailData, ...validation };
                
                // Show notification if high risk
                if (validation.riskLevel === 'high' && this.settings.showNotifications) {
                    this.showSecurityNotification(updatedData);
                }
                
                // Log detailed analysis
                if (this.settings.detailedLogging) {
                    console.log('SpoofGuard: Detailed analysis completed:', updatedData);
                }
            }
        } catch (error) {
            console.error('SpoofGuard: Error handling analyzed email:', error);
        }
    }

    async validateEmailHeaders(headers) {
        try {
            const parsedHeaders = this.parseEmailHeaders(headers);
            const domain = this.extractDomainFromHeaders(parsedHeaders);
            
            if (!domain) {
                return {
                    spf: { status: 'none', details: 'No domain found' },
                    dkim: { status: 'none', details: 'No domain found' },
                    dmarc: { status: 'none', details: 'No domain found' },
                    securityScore: 0,
                    riskLevel: 'high'
                };
            }

            // Perform DNS lookups for authentication records
            const [spfRecord, dmarcRecord] = await Promise.all([
                this.performDNSLookup(domain, 'TXT'),
                this.performDNSLookup(`_dmarc.${domain}`, 'TXT')
            ]);

            // Validate SPF
            const spfValidation = this.validateSPF(parsedHeaders, spfRecord);
            
            // Validate DKIM
            const dkimValidation = this.validateDKIM(parsedHeaders);
            
            // Validate DMARC
            const dmarcValidation = this.validateDMARC(parsedHeaders, dmarcRecord);

            const analysis = {
                spf: spfValidation,
                dkim: dkimValidation,
                dmarc: dmarcValidation,
                domain: domain,
                dnsRecords: {
                    spf: spfRecord,
                    dmarc: dmarcRecord
                }
            };

            analysis.securityScore = this.calculateSecurityScore(analysis);
            analysis.riskLevel = this.determineRiskLevel(analysis);
            analysis.recommendations = this.generateRecommendations(analysis);

            return analysis;
        } catch (error) {
            console.error('SpoofGuard: Error validating headers:', error);
            return {
                error: error.message,
                securityScore: 0,
                riskLevel: 'high'
            };
        }
    }

    parseEmailHeaders(headers) {
        const parsed = {};
        
        if (typeof headers === 'string') {
            const lines = headers.split('\n');
            let currentHeader = '';
            let currentValue = '';
            
            lines.forEach(line => {
                if (line.match(/^\s/)) {
                    // Continuation of previous header
                    currentValue += ' ' + line.trim();
                } else {
                    // Save previous header
                    if (currentHeader) {
                        parsed[currentHeader.toLowerCase()] = currentValue.trim();
                    }
                    
                    // Start new header
                    const colonIndex = line.indexOf(':');
                    if (colonIndex > 0) {
                        currentHeader = line.substring(0, colonIndex).trim();
                        currentValue = line.substring(colonIndex + 1).trim();
                    }
                }
            });
            
            // Save last header
            if (currentHeader) {
                parsed[currentHeader.toLowerCase()] = currentValue.trim();
            }
        }
        
        return parsed;
    }

    extractDomainFromHeaders(headers) {
        // Try to extract domain from various headers
        const fromHeader = headers['from'] || '';
        const returnPathHeader = headers['return-path'] || '';
        
        // Extract domain from email address
        const emailMatch = fromHeader.match(/@([^>\s]+)/);
        if (emailMatch) {
            return emailMatch[1].toLowerCase();
        }
        
        const returnPathMatch = returnPathHeader.match(/@([^>\s]+)/);
        if (returnPathMatch) {
            return returnPathMatch[1].toLowerCase();
        }
        
        return null;
    }

    async performDNSLookup(domain, recordType) {
        const cacheKey = `${domain}:${recordType}`;
        
        // Check cache first
        if (this.dnsCache.has(cacheKey)) {
            const cached = this.dnsCache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.settings.cacheTimeout) {
                return cached.data;
            }
        }

        try {
            // Use DNS over HTTPS (DoH) for DNS lookups
            const dohUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${recordType}`;
            
            const response = await fetch(dohUrl, {
                headers: {
                    'Accept': 'application/dns-json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`DNS lookup failed: ${response.status}`);
            }
            
            const data = await response.json();
            const records = data.Answer || [];
            
            // Extract TXT records for SPF/DMARC
            const txtRecords = records
                .filter(record => record.type === 16) // TXT record type
                .map(record => record.data.replace(/"/g, ''));
            
            // Cache the result
            this.dnsCache.set(cacheKey, {
                data: txtRecords,
                timestamp: Date.now()
            });
            
            return txtRecords;
        } catch (error) {
            console.error(`SpoofGuard: DNS lookup failed for ${domain}:`, error);
            return [];
        }
    }

    validateSPF(headers, spfRecords) {
        const spfRecord = spfRecords.find(record => record.startsWith('v=spf1'));
        
        if (!spfRecord) {
            return {
                status: 'none',
                details: 'No SPF record found',
                record: null
            };
        }

        // Check for SPF authentication results in headers
        const authResults = headers['authentication-results'] || '';
        const spfMatch = authResults.match(/spf=([^;\s]+)/i);
        
        if (spfMatch) {
            const status = spfMatch[1].toLowerCase();
            return {
                status: status,
                details: `SPF ${status}`,
                record: spfRecord
            };
        }

        // If no authentication results, assume pass for known good records
        if (spfRecord.includes('include:') || spfRecord.includes('a:') || spfRecord.includes('mx:')) {
            return {
                status: 'pass',
                details: 'SPF record exists with valid mechanisms',
                record: spfRecord
            };
        }

        return {
            status: 'neutral',
            details: 'SPF record found but status unclear',
            record: spfRecord
        };
    }

    validateDKIM(headers) {
        // Check for DKIM signature header
        const dkimSignature = headers['dkim-signature'];
        
        if (!dkimSignature) {
            return {
                status: 'none',
                details: 'No DKIM signature found'
            };
        }

        // Check authentication results
        const authResults = headers['authentication-results'] || '';
        const dkimMatch = authResults.match(/dkim=([^;\s]+)/i);
        
        if (dkimMatch) {
            const status = dkimMatch[1].toLowerCase();
            return {
                status: status,
                details: `DKIM ${status}`,
                signature: dkimSignature
            };
        }

        return {
            status: 'pass',
            details: 'DKIM signature present',
            signature: dkimSignature
        };
    }

    validateDMARC(headers, dmarcRecords) {
        const dmarcRecord = dmarcRecords.find(record => record.startsWith('v=DMARC1'));
        
        if (!dmarcRecord) {
            return {
                status: 'none',
                details: 'No DMARC record found',
                record: null
            };
        }

        // Check authentication results
        const authResults = headers['authentication-results'] || '';
        const dmarcMatch = authResults.match(/dmarc=([^;\s]+)/i);
        
        if (dmarcMatch) {
            const status = dmarcMatch[1].toLowerCase();
            return {
                status: status,
                details: `DMARC ${status}`,
                record: dmarcRecord
            };
        }

        // Parse DMARC policy
        const policyMatch = dmarcRecord.match(/p=([^;]+)/);
        const policy = policyMatch ? policyMatch[1] : 'none';
        
        return {
            status: 'pass',
            details: `DMARC policy: ${policy}`,
            record: dmarcRecord,
            policy: policy
        };
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
            } else if (status === 'temperror' || status === 'permerror') {
                score += weights[auth] * 0.2;
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
            recommendations.push('⚠️ SPF authentication failed - sender may be spoofed');
        } else if (analysis.spf.status === 'none') {
            recommendations.push('📧 No SPF record found - domain authentication unavailable');
        }
        
        if (analysis.dkim.status === 'fail') {
            recommendations.push('🔐 DKIM signature verification failed - email may be modified');
        } else if (analysis.dkim.status === 'none') {
            recommendations.push('✍️ No DKIM signature found - email authenticity unverified');
        }
        
        if (analysis.dmarc.status === 'fail') {
            recommendations.push('🛡️ DMARC policy violation - high risk of spoofing');
        } else if (analysis.dmarc.status === 'none') {
            recommendations.push('📋 No DMARC policy found - limited protection against spoofing');
        }
        
        if (analysis.riskLevel === 'high') {
            recommendations.push('🚨 Exercise extreme caution - verify sender through alternative means');
        } else if (analysis.riskLevel === 'medium') {
            recommendations.push('⚠️ Be cautious - some authentication checks failed');
        }
        
        return recommendations;
    }

    async showSecurityNotification(emailData) {
        if (!this.settings.showNotifications) return;
        
        const title = 'SpoofGuard Security Alert';
        let message = '';
        
        switch (emailData.riskLevel) {
            case 'high':
                message = `High-risk email detected from ${emailData.sender}. Authentication failed.`;
                break;
            case 'medium':
                message = `Suspicious email from ${emailData.sender}. Partial authentication failure.`;
                break;
            default:
                return; // Don't notify for low risk
        }
        
        try {
            await chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/icon48.png',
                title: title,
                message: message,
                priority: emailData.riskLevel === 'high' ? 2 : 1
            });
        } catch (error) {
            console.error('SpoofGuard: Error showing notification:', error);
        }
    }

    async updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        await chrome.storage.sync.set({ spoofGuardSettings: this.settings });
        
        // Notify content scripts of settings change
        const tabs = await chrome.tabs.query({});
        tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
                type: 'SETTINGS_UPDATED',
                settings: this.settings
            }).catch(() => {}); // Ignore errors for tabs without content script
        });
    }

    async getGmailHeaders(messageId, url) {
        try {
            console.log('SpoofGuard: Attempting to get Gmail headers via API');
            
            // First try to authenticate if not already done
            const isAuthenticated = await this.gmailAPI.authenticate();
            if (!isAuthenticated) {
                throw new Error('Gmail API authentication failed');
            }
            
            // Extract message ID if not provided
            let actualMessageId = messageId;
            if (!actualMessageId && url) {
                actualMessageId = this.gmailAPI.extractMessageIdFromUrl(url);
            }
            
            if (!actualMessageId) {
                throw new Error('Could not determine Gmail message ID');
            }
            
            console.log('SpoofGuard: Fetching headers for message ID:', actualMessageId);
            
            // Get raw headers from Gmail API
            const apiData = await this.gmailAPI.getRawEmailHeaders(actualMessageId);
            if (!apiData || !apiData.headers) {
                throw new Error('Failed to fetch raw headers from Gmail API');
            }

            // Extract authentication results from raw headers
            const authResults = apiData.authenticationResults;

            console.log('SpoofGuard: Gmail API authentication results:', authResults);

            return {
                success: true,
                headers: apiData.headers,
                authentication: authResults,
                source: 'gmail_api'
            };
            
        } catch (error) {
            console.error('SpoofGuard: Gmail API header extraction failed:', error);
            return {
                success: false,
                error: error.message,
                source: 'gmail_api'
            };
        }
    }

    clearExpiredCache() {
        const now = Date.now();
        const timeout = this.settings.cacheTimeout;
        
        // Clear DNS cache
        for (const [key, value] of this.dnsCache.entries()) {
            if (now - value.timestamp > timeout) {
                this.dnsCache.delete(key);
            }
        }
        
        // Clear email cache (keep for longer - 1 hour)
        for (const [key, value] of this.emailCache.entries()) {
            if (now - value.timestamp > timeout * 12) {
                this.emailCache.delete(key);
            }
        }
        
        console.log('SpoofGuard: Cache cleared');
    }
}

// Initialize background service worker
try {
    new SpoofGuardBackground();
} catch (error) {
    console.error('SpoofGuard: Failed to initialize background service worker:', error);
}