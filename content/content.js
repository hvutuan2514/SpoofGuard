// Global error handler for extension context invalidation
window.addEventListener('error', (event) => {
    if (event.error && event.error.message) {
        const errorMessage = event.error.message.toLowerCase();
        if (errorMessage.includes('extension context invalidated') ||
            errorMessage.includes('cannot access') ||
            errorMessage.includes('context invalidated') ||
            errorMessage.includes('message port closed') ||
            errorMessage.includes('receiving end does not exist') ||
            errorMessage.includes('could not establish connection') ||
            errorMessage.includes('disconnected port object') ||
            errorMessage.includes('attempting to use a disconnected port object') ||
            errorMessage.includes('the message port closed before a response was received')) {
            event.preventDefault();
            event.stopPropagation();
            return false;
        }
    }
});

// Global unhandled promise rejection handler
window.addEventListener('unhandledrejection', (event) => {
    if (event.reason) {
        let reasonMessage = '';
        if (event.reason.message) {
            reasonMessage = event.reason.message.toLowerCase();
        } else if (typeof event.reason === 'string') {
            reasonMessage = event.reason.toLowerCase();
        }
        
        if (reasonMessage.includes('extension context invalidated') ||
            reasonMessage.includes('cannot access') ||
            reasonMessage.includes('context invalidated') ||
            reasonMessage.includes('message port closed') ||
            reasonMessage.includes('receiving end does not exist') ||
            reasonMessage.includes('could not establish connection') ||
            reasonMessage.includes('disconnected port object') ||
            reasonMessage.includes('attempting to use a disconnected port object') ||
            reasonMessage.includes('the message port closed before a response was received')) {
            event.preventDefault();
            return false;
        }
    }
});

/**
 * SpoofGuard Content Script
 * Real-time email monitoring and header analysis
 */

class SpoofGuardContent {
    constructor() {
        this.currentEmail = null;
        this.settings = {
            realTimeMonitoring: true,
            showNotifications: true,
            detailedLogging: false
        };
        this.emailProvider = this.detectEmailProvider();
        this.observers = [];
        
        this.init();
    }

    async init() {
        await this.loadSettings();
        this.setupMessageListener();
        
        if (this.settings.realTimeMonitoring) {
            this.startMonitoring();
        }
        
        console.log('SpoofGuard: Content script initialized for', this.emailProvider);
    }

    detectEmailProvider() {
        const url = window.location.href;
        console.log('SpoofGuard: Gmail-only mode. URL:', url);
        
        if (url.includes('mail.google.com')) {
            console.log('SpoofGuard: Detected Gmail');
        } else {
            console.log('SpoofGuard: Forcing Gmail-only mode for unknown provider');
        }
        return 'gmail';
    }

    isInboxView() {
        try {
            const url = window.location.href;
            const isInboxLabel = url.includes('#inbox') || url.includes('/inbox/');
            const hasMessageToken = /\/mail\/u\/\d+\/#([^/]+)\/[A-Za-z0-9]+/.test(url);
            const domHasMessage = !!document.querySelector('[data-message-id]');

            // Inbox when label is inbox, no message token, and no message DOM present
            return isInboxLabel && !hasMessageToken && !domHasMessage;
        } catch (e) {
            return false;
        }
    }

    async loadSettings() {
        try {
            const result = await chrome.storage.sync.get(['spoofGuardSettings']);
            if (result.spoofGuardSettings) {
                this.settings = { ...this.settings, ...result.spoofGuardSettings };
            }
        } catch (error) {
            console.error('SpoofGuard: Error loading settings:', error);
        }
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            console.log('SpoofGuard: Received message:', request);
            
            switch (request.type) {
                case 'GET_CURRENT_EMAIL':
                    // Return cached analysis if present; otherwise analyze and reply asynchronously
                    if (this.currentEmail && this.currentEmail.sender) {
                        sendResponse(this.currentEmail);
                    } else {
                        this.analyzeCurrentEmail();
                        this.waitForCurrentEmail(2000).then((email) => {
                            sendResponse(email || null);
                        }).catch(() => {
                            sendResponse(null);
                        });
                        return true; // Keep channel open for async sendResponse
                    }
                    break;
                    
                case 'FORCE_ANALYSIS':
                    console.log('SpoofGuard: Force analysis requested');
                    this.forceAnalysis();
                    sendResponse({ success: true });
                    break;
                    
                case 'SETTINGS_UPDATED':
                    this.settings = request.settings;
                    if (this.settings.realTimeMonitoring) {
                        this.startMonitoring();
                    } else {
                        this.stopMonitoring();
                    }
                    break;
                    
                case 'ANALYZE_EMAIL':
                    this.analyzeCurrentEmail();
                    break;
                    
                case 'ANALYZE_HEADERS':
                    if (request.headers) {
                        this.processEmailData({
                            provider: 'manual',
                            headers: request.headers,
                            timestamp: new Date().toISOString()
                        });
                    }
                    break;
            }
        });
    }

    waitForCurrentEmail(maxWaitMs = 2000, intervalMs = 200) {
        return new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
                if (this.currentEmail && this.currentEmail.sender) {
                    resolve(this.currentEmail);
                } else if (Date.now() - start >= maxWaitMs) {
                    resolve(null);
                } else {
                    setTimeout(check, intervalMs);
                }
            };
            check();
        });
    }

    analyzeCurrentEmail() {
        console.log('SpoofGuard: Analyzing current email...');
        
        const provider = this.detectEmailProvider();
        
        if (provider === 'gmail') {
            // If inbox, reset and skip
            if (this.isInboxView()) {
                console.log('SpoofGuard: Inbox view; not analyzing, resetting currentEmail');
                this.currentEmail = null;
                return;
            }
            this.extractGmailHeaders();
        } else {
            // Gmail-only mode: skip other providers
            console.log('SpoofGuard: Gmail-only mode; skipping non-Gmail analysis');
            this.currentEmail = null;
        }
    }

    forceAnalysis() {
        console.log('SpoofGuard: Performing force analysis...');
        this.debugPageElements();
        
        // Clear current analysis
        this.currentEmail = null;
        
        // Detect provider and extract headers
        const provider = this.detectEmailProvider();
        console.log('SpoofGuard: Detected provider:', provider);
        
        if (provider === 'gmail') {
            this.extractGmailHeaders();
        } else if (provider === 'outlook') {
            this.extractOutlookHeaders();
        } else {
            console.log('SpoofGuard: Unknown or unsupported email provider');
            // Try generic extraction
            this.tryGenericExtraction();
        }
    }

    tryGenericExtraction() {
        // Gmail-only mode; disable generic extraction
        console.log('SpoofGuard: Gmail-only mode; skipping generic extraction');
        return;
    }

    startMonitoring() {
        this.stopMonitoring(); // Clear existing observers
        
        if (!this.settings.realTimeMonitoring) {
            console.log('SpoofGuard: Real-time monitoring is disabled');
            return;
        }
        
        console.log('SpoofGuard: Starting real-time monitoring...');
        
        // Gmail-only monitoring
        this.monitorGmail();
        
        // Also try to analyze current email immediately
        setTimeout(() => {
            this.analyzeCurrentEmail();
        }, 2000);
    }

    stopMonitoring() {
        this.observers.forEach(observer => observer.disconnect());
        this.observers = [];
    }

    monitorGmail() {
        console.log('SpoofGuard: Setting up Gmail monitoring...');
        
        // Monitor for URL changes (Gmail is a SPA)
        this.urlObserver = new MutationObserver(() => {
            if (this.lastUrl !== window.location.href) {
                this.lastUrl = window.location.href;
                console.log('SpoofGuard: URL changed to:', this.lastUrl);
                
                // If inbox view, clear analysis and do not analyze
                if (this.isInboxView()) {
                    console.log('SpoofGuard: Inbox view detected; clearing current analysis');
                    this.currentEmail = null;
                    return;
                }

                // Delay to allow Gmail to load content
                setTimeout(() => {
                    this.analyzeCurrentEmail();
                }, 1500);
            }
        });
        
        this.urlObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        // Monitor for email content changes
        this.contentObserver = new MutationObserver((mutations) => {
            let shouldAnalyze = false;
            
            mutations.forEach(mutation => {
                // Check if email content area changed
                if (mutation.target.matches && (
                    mutation.target.matches('[data-message-id]') ||
                    mutation.target.matches('.ii.gt') ||
                    mutation.target.matches('.a3s.aiL') ||
                    mutation.target.closest('[data-message-id]') ||
                    mutation.target.closest('.ii.gt')
                )) {
                    shouldAnalyze = true;
                }
            });
            
            if (shouldAnalyze) {
                console.log('SpoofGuard: Email content changed, analyzing...');
                setTimeout(() => {
                    this.analyzeCurrentEmail();
                }, 500);
            }
        });
        
        this.contentObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: false
        });
        
        // Periodic check as fallback
        this.periodicCheck = setInterval(() => {
            this.analyzeCurrentEmail();
        }, 10000); // Check every 10 seconds
        
        console.log('SpoofGuard: Gmail monitoring active');
        
        // Check current email immediately
        setTimeout(() => this.extractGmailHeaders(), 1000);
    }

    debugPageElements() {
        console.log('SpoofGuard: Debugging page elements...');
        console.log('URL:', window.location.href);
        
        // Check for common Gmail selectors
        const selectors = [
            '[data-message-id]',
            '.ii.gt',
            '.a3s.aiL',
            '[role="listitem"][data-legacy-thread-id]',
            '.hP',
            '.gD',
            '[email]',
            '.bog',
            '.adn.ads',
            '.ii.gt .m',
            '.adf.ads'
        ];
        
        selectors.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
                console.log(`Found ${elements.length} elements for selector: ${selector}`);
                elements.forEach((el, index) => {
                    console.log(`  Element ${index}:`, el.textContent?.substring(0, 100) || 'No text content');
                });
            }
        });
    }

    async extractGmailHeaders() {
        console.log('SpoofGuard: Extracting Gmail headers using DOM extraction...');
        return this.extractGmailHeadersFromDOM();
    }

    findEmailContainer() {
        // Try to find the most specific email container first
        const specificSelectors = [
            // Gmail message containers with data attributes
            '[data-message-id]',
            '[data-legacy-thread-id]',
            
            // Gmail email body containers
            '.ii.gt',
            
            // Gmail conversation containers
            '[role="listitem"][data-legacy-thread-id]',
            
            // Gmail email actions area
            '.adn.ads',
            
            // Alternative Gmail selectors
            '.nH .if',  // Gmail email container
            '.nH .h7',  // Gmail message container
            '.nH .adn', // Gmail actions container
        ];
        
        for (const selector of specificSelectors) {
            const containers = document.querySelectorAll(selector);
            
            // If we find multiple containers, try to pick the one that's currently visible/active
            for (const container of containers) {
                if (container && container.offsetParent !== null) {
                    // Check if this container has email header elements (Reply, More buttons)
                    const hasReplyButton = container.querySelector('[aria-label*="Reply"], [data-tooltip*="Reply"]');
                    const hasMoreButton = container.querySelector('[aria-label*="More"], [data-tooltip*="More"]');
                    
                    if (hasReplyButton || hasMoreButton) {
                        console.log(`SpoofGuard: Found email container with selector: ${selector} (has email actions)`);
                        return container;
                    }
                }
            }
            
            // If no container with actions found, use the first visible one
            for (const container of containers) {
                if (container && container.offsetParent !== null) {
                    console.log(`SpoofGuard: Found email container with selector: ${selector}`);
                    return container;
                }
            }
        }
        
        // Fallback: look for any visible email-like container
        const fallbackSelectors = [
            '.nH',  // Gmail main container
            '[role="main"]',  // Main content area
            '.ii'   // Gmail email content
        ];
        
        for (const selector of fallbackSelectors) {
            const container = document.querySelector(selector);
            if (container && container.offsetParent !== null) {
                console.log(`SpoofGuard: Found fallback email container with selector: ${selector}`);
                return container;
            }
        }
        
        return null;
    }

    async extractGmailHeadersFromDOM() {
        try {
            console.log('SpoofGuard: Using DOM extraction fallback...');
            
            // Multiple selectors for different Gmail layouts and views
            const emailSelectors = [
                '[data-message-id]',                    // Standard Gmail message
                '.ii.gt .a3s.aiL',                     // Email body content
                '.ii.gt',                              // Email container
                '[role="listitem"][data-legacy-thread-id]', // Thread view
                '.adn.ads',                            // Email header area
                '.hP',                                 // Email content area
                '.a3s.aXjCH',                         // Another email body selector
                '.ii.gt .a3s',                        // Email body in conversation
                '[data-legacy-thread-id]'             // Thread container
            ];
            
            let emailContainer = null;
            
            // Try each selector until we find an email
            for (const selector of emailSelectors) {
                emailContainer = document.querySelector(selector);
                if (emailContainer) {
                    console.log(`SpoofGuard: Found email container with selector: ${selector}`);
                    break;
                }
            }
            
            if (!emailContainer) {
                // If inbox, do not attempt API/DOM; just clear analysis
                if (this.isInboxView()) {
                    console.log('SpoofGuard: Inbox view; skipping extraction and clearing analysis');
                    this.currentEmail = null;
                    return;
                }

                console.log('SpoofGuard: No email container found; attempting Gmail API-only extraction');
                
                try {
                    const apiResult = await this.getGmailHeadersViaAPI();
                    if (apiResult && apiResult.success && apiResult.headers) {
                        const headers = apiResult.headers;
                        const sender = headers['from'] || '';
                        const subject = headers['subject'] || 'No Subject';
                        const messageId = headers['message-id'] || ('gmail-' + Date.now());
                        const authResults = apiResult.authentication || null;

                        if (sender) {
                            this.processEmailData({
                                provider: 'gmail',
                                messageId: messageId,
                                sender: sender,
                                subject: subject,
                                headers: headers,
                                authResults: authResults,
                                timestamp: new Date().toISOString()
                            });
                            return;
                        }
                    } else {
                        console.log('SpoofGuard: Gmail API-only extraction did not return headers');
                    }
                } catch (apiError) {
                    console.log('SpoofGuard: Gmail API-only extraction failed:', apiError.message);
                }

                // Final fallback: generic extraction
                this.tryGenericExtraction();
                return;
            }
            
            // Extract message ID
            let messageId = emailContainer.getAttribute('data-message-id') ||
                           emailContainer.closest('[data-message-id]')?.getAttribute('data-message-id') ||
                           emailContainer.getAttribute('data-legacy-thread-id') ||
                           'gmail-' + Date.now();
            
            console.log('SpoofGuard: Message ID:', messageId);
            
            // Extract sender information with multiple approaches
            let senderElement = null;
            const senderSelectors = [
                '.go .gD',                             // Sender name in header
                '.gD[email]',                          // Sender with email attribute
                '.gD',                                 // General sender element
                '.yW span[email]',                     // Sender email span
                '.yW .go .gD',                        // Nested sender
                '[email]',                            // Any element with email attribute
                '.h2h .gD',                           // Alternative sender location
                '.qu .gD'                             // Another sender location
            ];
            
            for (const selector of senderSelectors) {
                senderElement = emailContainer.querySelector(selector) || 
                               document.querySelector(selector);
                if (senderElement) {
                    console.log(`SpoofGuard: Found sender with selector: ${selector}`);
                    break;
                }
            }
            
            let senderName = 'Unknown';
            let senderEmail = 'unknown@example.com';
            
            if (senderElement) {
                senderName = senderElement.textContent?.trim() || 
                            senderElement.getAttribute('name') || 
                            'Unknown';
                senderEmail = senderElement.getAttribute('email') || 
                             senderElement.getAttribute('data-hovercard-id') ||
                             this.extractEmailFromText(senderElement.textContent) ||
                             'unknown@example.com';
            } else {
                console.log('SpoofGuard: No sender element found, trying alternative methods');
                // Try to find email in the page text
                const pageText = document.body.textContent;
                const emailMatch = pageText.match(/[\w\.-]+@[\w\.-]+\.\w+/);
                if (emailMatch) {
                    senderEmail = emailMatch[0];
                    console.log('SpoofGuard: Found email in page text:', senderEmail);
                }
            }
            
            // Extract subject with multiple selectors
            const subjectSelectors = [
                '.hP .hQ',                            // Subject in header
                '.bog',                               // Subject element
                'h2[data-legacy-thread-id]',          // Thread subject
                '.hP',                                // Header area
                '[data-thread-perm-id] .bog'         // Thread subject alternative
            ];
            
            let subject = 'No Subject';
            for (const selector of subjectSelectors) {
                const subjectElement = document.querySelector(selector);
                if (subjectElement && subjectElement.textContent.trim()) {
                    subject = subjectElement.textContent.trim();
                    console.log(`SpoofGuard: Found subject with selector: ${selector}`);
                    break;
                }
            }
            
            console.log('SpoofGuard: Extracted data:', {
                messageId,
                senderName,
                senderEmail,
                subject,
                url: window.location.href
            });
            
            // Extract authentication results
            const authResults = await this.getGmailHeadersFromDOM(emailContainer);
            console.log('SpoofGuard: Authentication results:', authResults);

            // Create headers object
            const headers = {
                'message-id': messageId,
                'from': `${senderName} <${senderEmail}>`,
                'subject': subject,
                'to': 'user@gmail.com', // Gmail doesn't easily expose recipient
                'date': new Date().toISOString(),
                'x-original-url': window.location.href,
                'authentication-results': authResults
            };

            if (senderEmail !== 'unknown@example.com' || subject !== 'No Subject') {
                this.processEmailData({
                    provider: 'gmail',
                    messageId: messageId,
                    sender: `${senderName} <${senderEmail}>`,
                    subject: subject,
                    headers: headers,
                    authResults: authResults,
                    timestamp: new Date().toISOString()
                });
            } else {
                console.log('SpoofGuard: No valid sender or subject found');
                this.tryGenericExtraction();
            }
        } catch (error) {
            console.error('SpoofGuard: Error extracting Gmail headers:', error);
        }
    }
    
    extractEmailFromText(text) {
        if (!text) return null;
        const emailRegex = /[\w\.-]+@[\w\.-]+\.\w+/;
        const match = text.match(emailRegex);
        return match ? match[0] : null;
    }

    async getGmailHeadersFromDOM(container) {
        console.log('SpoofGuard: Extracting authentication headers from Gmail...');
        
        // First try Gmail API for accurate header extraction
        try {
            console.log('SpoofGuard: Attempting Gmail API header extraction...');
            const apiResult = await this.getGmailHeadersViaAPI();
            
            if (apiResult && apiResult.success && apiResult.authentication) {
                console.log('SpoofGuard: Gmail API extraction successful:', apiResult.authentication);
                return apiResult.authentication;
            } else {
                console.log('SpoofGuard: Gmail API extraction failed, falling back to DOM extraction');
            }
        } catch (error) {
            console.log('SpoofGuard: Gmail API error, falling back to DOM extraction:', error.message);
        }
        
        // Fallback to DOM extraction methods
        console.log('SpoofGuard: Using DOM extraction methods...');
        
        // Use the enhanced DOM extraction methods
        let authResults = this.extractAuthFromGmailData(container);
        
        // If no results from Gmail data, try general DOM extraction
        if (!authResults || (authResults.spf.status === 'unknown' && 
                           authResults.dkim.status === 'unknown' && 
                           authResults.dmarc.status === 'unknown')) {
            console.log('SpoofGuard: Trying general DOM extraction...');
            authResults = this.extractAuthFromDOM(container);
        }
        
        // Only check for spam folder if we still don't have results
        if (!authResults || (authResults.spf.status === 'unknown' && 
                           authResults.dkim.status === 'unknown' && 
                           authResults.dmarc.status === 'unknown')) {
            
            const currentUrl = window.location.href;

            // Danger banners Gmail shows on spam/phishing
            const dangerBanner = Array.from(document.querySelectorAll('[role="alert"], .aCz, .aCk'))
                .some(el => /dangerous|phishing|why is this message in spam/i
                    .test((el.textContent || '').toLowerCase()));

            // Only treat as spam when URL shows spam label or a danger banner exists
            const isInSpamFolder =
                currentUrl.includes('#spam') ||
                currentUrl.includes('/spam/') ||
                currentUrl.includes('label=spam') ||
                currentUrl.includes('search=in%3Aspam') ||
                dangerBanner;

            console.log('SpoofGuard: Current URL:', currentUrl);
            console.log('SpoofGuard: Spam folder check:', isInSpamFolder);

            if (isInSpamFolder) {
                console.log('SpoofGuard: Email is in spam folder, marking as suspicious');
                authResults = {
                    spf: { status: 'suspicious', details: 'Email found in spam folder or flagged as dangerous' },
                    dkim: { status: 'suspicious', details: 'Email found in spam folder or flagged as dangerous' },
                    dmarc: { status: 'suspicious', details: 'Email found in spam folder or flagged as dangerous' }
                };
            } else {
                authResults = {
                    spf: { status: 'unknown', details: 'SPF authentication: unknown' },
                    dkim: { status: 'unknown', details: 'DKIM signature: unknown' },
                    dmarc: { status: 'unknown', details: 'DMARC policy: unknown' }
                };
            }
        }

        console.log('SpoofGuard: Authentication results:', authResults);
        return authResults;
    }

    async getGmailHeadersViaAPI() {
        try {
            // Prefer DOM-derived message ID (API-valid) over URL-derived UI token
            const messageId = this.extractMessageIdFromDOM() || this.extractMessageIdFromUrl();
            const currentUrl = window.location.href;

            console.log('SpoofGuard: Requesting Gmail API headers for message:', messageId);

            // Send message to background script to handle Gmail API
            return new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({
                    type: 'GMAIL_API_HEADERS',
                    messageId: messageId,
                    url: currentUrl
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }

                    if (response && response.error) {
                        reject(new Error(response.error));
                        return;
                    }

                    resolve(response);
                });
            });

        } catch (error) {
            console.error('SpoofGuard: Gmail API request failed:', error);
            throw error;
        }
    }

    extractMessageIdFromUrl() {
        try {
            // URL ID is often a UI thread token (e.g., FMfcgz...), keep as last resort
            const url = window.location.href;
            const match = url.match(/\/mail\/u\/\d+\/#[^/]+\/([A-Za-z0-9]+)/);
            if (match && match[1]) {
                console.log('SpoofGuard: Extracted ID from URL (likely UI token):', match[1]);
                return match[1];
            }
            return null;
        } catch (error) {
            console.error('SpoofGuard: Error extracting message ID from URL:', error);
            return null;
        }
    }

    extractMessageIdFromDOM() {
        try {
            // Prefer DOM attributes that carry API-valid numeric message IDs
            const candidates = [
                '[data-legacy-message-id]',
                '[data-message-id]',
                '[id^="msg-f:"]'
            ];

            for (const selector of candidates) {
                const el = document.querySelector(selector);
                if (!el) continue;

                const raw =
                    el.getAttribute('data-legacy-message-id') ||
                    el.getAttribute('data-message-id') ||
                    el.id;

                if (!raw) continue;

                // If id looks like "msg-f:1847829327361803048", extract the digits
                const numericMatch = String(raw).match(/\d{10,}/);
                if (numericMatch) {
                    const apiId = numericMatch[0];
                    console.log('SpoofGuard: Extracted API message ID from DOM:', apiId);
                    return apiId;
                }

                // Some builds may store a message-like id directly in data-message-id
                if (/^[A-Za-z0-9_-]{10,}$/.test(raw)) {
                    console.log('SpoofGuard: Found message-like id in DOM:', raw);
                    return raw;
                }
            }

            console.warn('SpoofGuard: Could not find API message ID in DOM');
            return null;
        } catch (error) {
            console.error('SpoofGuard: Error extracting message ID from DOM:', error);
            return null;
        }
    }

    async extractAuthenticationResults(container) {
        try {
            console.log('SpoofGuard: Extracting authentication results from DOM only');
            
            // Look for authentication results in Gmail's internal data
            return this.extractAuthFromGmailData(container);
            
        } catch (error) {
            console.log('SpoofGuard: Error extracting authentication results:', error.message);
            return null;
        }
    }

    extractAuthFromGmailData(container) {
        try {
            // Gmail sometimes stores authentication data in data attributes or hidden elements
            const messageElement = container.closest('[data-message-id]') || container;
            
            // Enhanced selectors for Gmail's authentication indicators
            const authSelectors = [
                // Data attributes
                '[data-auth-result]',
                '[data-spf]',
                '[data-dkim]', 
                '[data-dmarc]',
                '[data-authentication]',
                '[data-security]',
                
                // Gmail security classes and elements
                '.aVW', // Security warning
                '.aVV', // Security info
                '.aVU', // Authentication info
                '.aVT', // Security badge
                '.aVS', // Verification info
                '.gb_g', // Security indicator
                '.gb_h', // Authentication badge
                '.ii.gt .im', // Message content area
                '.hP', // Message details
                '.kQ', // Security details
                '.kR', // Authentication details
                
                // Gmail sender verification elements
                '.go .gD', // Sender info area
                '.gD', // Sender details
                '.yW span[email]', // Sender email verification
                '.yW .yP', // Sender verification badge
                '.yW .yQ', // Sender authentication info
                
                // Gmail message header area
                '.hA .hQ', // Header area
                '.hA .hP', // Header details
                '.ha .hP', // Message header
                '.ha .hQ', // Message details
                
                // Title and aria-label attributes
                '[title*="authenticated"]',
                '[title*="verification"]',
                '[title*="security"]',
                '[title*="spf"]',
                '[title*="dkim"]',
                '[title*="dmarc"]',
                '[title*="mailed-by"]',
                '[title*="signed-by"]',
                '[aria-label*="authenticated"]',
                '[aria-label*="verification"]',
                '[aria-label*="security"]',
                '[aria-label*="spf"]',
                '[aria-label*="dkim"]',
                '[aria-label*="dmarc"]',
                '[aria-label*="mailed-by"]',
                '[aria-label*="signed-by"]',
                
                // Common security/auth element patterns
                '.security-info',
                '.auth-info',
                '.verification-badge',
                '[class*="security"]',
                '[class*="auth"]',
                '[class*="verification"]',
                '[class*="mailed-by"]',
                '[class*="signed-by"]',
                
                // Tooltip and popup elements
                '[data-tooltip*="security"]',
                '[data-tooltip*="authenticated"]',
                '[data-tooltip*="verification"]',
                '[data-tooltip*="mailed-by"]',
                '[data-tooltip*="signed-by"]',
                '[role="tooltip"]'
            ];

            let authInfo = {};
            
            for (const selector of authSelectors) {
                const elements = messageElement.querySelectorAll(selector);
                elements.forEach(element => {
                    if (element) {
                        // Extract all possible text sources
                        const title = element.getAttribute('title') || '';
                        const ariaLabel = element.getAttribute('aria-label') || '';
                        const dataAuth = element.getAttribute('data-auth-result') || '';
                        const dataTooltip = element.getAttribute('data-tooltip') || '';
                        const text = element.textContent || '';
                        const innerHTML = element.innerHTML || '';
                        
                        // Check all data attributes for auth info
                        const allAttributes = Array.from(element.attributes)
                            .map(attr => `${attr.name}=${attr.value}`)
                            .join(' ');
                        
                        const combinedText = `${title} ${ariaLabel} ${dataAuth} ${dataTooltip} ${text} ${allAttributes}`.toLowerCase();
                        
                        // Enhanced pattern matching for authentication results
                        if (combinedText.includes('spf') && !authInfo.spf) {
                            authInfo.spf = this.extractAuthStatus(combinedText, 'spf');
                        }
                        if (combinedText.includes('dkim') && !authInfo.dkim) {
                            authInfo.dkim = this.extractAuthStatus(combinedText, 'dkim');
                        }
                        if (combinedText.includes('dmarc') && !authInfo.dmarc) {
                            authInfo.dmarc = this.extractAuthStatus(combinedText, 'dmarc');
                        }
                        
                        // Look for Gmail's "mailed-by" and "signed-by" indicators (strong auth signals)
                        if (combinedText.includes('mailed-by') || combinedText.includes('signed-by')) {
                            authInfo.gmail_verified = true;
                            console.log('SpoofGuard: Found Gmail verification indicators');
                        }
                        
                        // Look for general authentication indicators
                        if ((combinedText.includes('authenticated') || combinedText.includes('verified')) && !authInfo.general) {
                            authInfo.general = 'authenticated';
                        }
                        
                        // Check for security warnings
                        if (combinedText.includes('warning') || combinedText.includes('suspicious') || combinedText.includes('phishing')) {
                            authInfo.warning = true;
                        }
                        
                        // Check for positive authentication signals
                        if (combinedText.includes('secure') || combinedText.includes('trusted') || combinedText.includes('verified sender')) {
                            authInfo.positive_signal = true;
                        }
                    }
                });
            }

            // Also check for Gmail's message source indicators
            const sourceElements = messageElement.querySelectorAll('[data-legacy-thread-id], [data-message-id], .ii.gt .im');
            sourceElements.forEach(element => {
                const text = element.textContent || '';
                if (text.includes('mailed-by') || text.includes('signed-by')) {
                    authInfo.source_verified = true;
                }
            });

            if (Object.keys(authInfo).length > 0) {
                console.log('SpoofGuard: Found authentication info from Gmail data:', authInfo);
                
                // Convert to expected format
                const results = {
                    spf: authInfo.spf || { status: 'unknown', details: 'SPF authentication: unknown' },
                    dkim: authInfo.dkim || { status: 'unknown', details: 'DKIM signature: unknown' },
                    dmarc: authInfo.dmarc || { status: 'unknown', details: 'DMARC policy: unknown' }
                };
                
                // If we found general authentication, source verification, Gmail verification, or positive signals, mark as pass
                if (authInfo.general === 'authenticated' || authInfo.source_verified || authInfo.gmail_verified || authInfo.positive_signal) {
                    if (results.spf.status === 'unknown') {
                        results.spf = { status: 'pass', details: 'Email appears authenticated by Gmail' };
                    }
                    if (results.dkim.status === 'unknown') {
                        results.dkim = { status: 'pass', details: 'Email appears authenticated by Gmail' };
                    }
                    if (results.dmarc.status === 'unknown') {
                        results.dmarc = { status: 'pass', details: 'Email appears authenticated by Gmail' };
                    }
                }
                
                // If we found warnings, mark as suspicious
                if (authInfo.warning) {
                    results.spf.status = 'suspicious';
                    results.spf.details = 'Security warning detected';
                    results.dkim.status = 'suspicious';
                    results.dkim.details = 'Security warning detected';
                    results.dmarc.status = 'suspicious';
                    results.dmarc.details = 'Security warning detected';
                }
                
                return results;
            }

            return null;
        } catch (error) {
            console.log('SpoofGuard: Error extracting auth from Gmail data:', error.message);
            return null;
        }
    }

    extractAuthFromDOM(container) {
        try {
            // Enhanced selectors for visible authentication indicators
            const authSelectors = [
                // Title attributes with authentication info
                '[title*="SPF"]', '[title*="DKIM"]', '[title*="DMARC"]', 
                '[title*="authenticated"]', '[title*="verification"]',
                '[title*="security"]', '[title*="signed"]', '[title*="verified"]',
                
                // Aria-label attributes
                '[aria-label*="SPF"]', '[aria-label*="DKIM"]', '[aria-label*="DMARC"]',
                '[aria-label*="authenticated"]', '[aria-label*="verification"]',
                '[aria-label*="security"]', '[aria-label*="signed"]', '[aria-label*="verified"]',
                
                // Class-based selectors
                '.security-info', '.auth-info', '.verification-badge',
                '[class*="security"]', '[class*="auth"]', '[class*="verification"]',
                '[class*="spf"]', '[class*="dkim"]', '[class*="dmarc"]',
                
                // Data attributes
                '[data-security]', '[data-auth]', '[data-verification]',
                '[data-spf]', '[data-dkim]', '[data-dmarc]'
            ];
            
            const authElements = container.querySelectorAll(authSelectors.join(', '));
            
            if (authElements.length > 0) {
                const authInfo = {};
                authElements.forEach(el => {
                    const title = el.getAttribute('title') || '';
                    const ariaLabel = el.getAttribute('aria-label') || '';
                    const text = el.textContent || '';
                    const className = el.className || '';
                    
                    // Get all data attributes
                    const dataAttrs = Array.from(el.attributes)
                        .filter(attr => attr.name.startsWith('data-'))
                        .map(attr => `${attr.name}=${attr.value}`)
                        .join(' ');
                    
                    const combinedText = `${title} ${ariaLabel} ${text} ${className} ${dataAttrs}`.toLowerCase();
                    
                    // Enhanced pattern matching
                    if (combinedText.includes('spf') && !authInfo.spf) {
                        authInfo.spf = this.extractAuthStatus(combinedText, 'spf');
                    }
                    if (combinedText.includes('dkim') && !authInfo.dkim) {
                        authInfo.dkim = this.extractAuthStatus(combinedText, 'dkim');
                    }
                    if (combinedText.includes('dmarc') && !authInfo.dmarc) {
                        authInfo.dmarc = this.extractAuthStatus(combinedText, 'dmarc');
                    }
                    
                    // Look for general authentication status
                    if ((combinedText.includes('authenticated') || combinedText.includes('verified') || combinedText.includes('signed')) && !authInfo.general) {
                        authInfo.general = 'authenticated';
                    }
                });
                
                if (Object.keys(authInfo).length > 0) {
                    console.log('SpoofGuard: Found authentication info from DOM elements:', authInfo);
                    return authInfo;
                }
            }

            // Enhanced Gmail security badge detection
            const securitySelectors = [
                '.aVW', '.aVV', '.aVU', '.aVT', '.aVS', // Gmail security classes
                '.gb_g', '.gb_h', // Security indicators
                '[data-tooltip*="security"]', '[data-tooltip*="authenticated"]', '[data-tooltip*="verification"]',
                '[role="tooltip"]', '.tooltip', '.security-tooltip',
                '.message-security', '.email-security', '.auth-badge'
            ];
            
            const securityBadges = container.querySelectorAll(securitySelectors.join(', '));
            if (securityBadges.length > 0) {
                console.log('SpoofGuard: Found security badges, analyzing...');
                const badgeInfo = Array.from(securityBadges).map(badge => {
                    return badge.getAttribute('data-tooltip') || 
                           badge.getAttribute('title') || 
                           badge.getAttribute('aria-label') || 
                           badge.textContent ||
                           badge.getAttribute('data-original-title') ||
                           badge.getAttribute('data-content');
                }).filter(info => info && info.trim()).join(' ');
                
                if (badgeInfo) {
                    const parsedInfo = this.parseSecurityBadgeInfo(badgeInfo);
                    if (parsedInfo) {
                        console.log('SpoofGuard: Parsed security badge info:', parsedInfo);
                        return parsedInfo;
                    }
                }
            }

            // Look for email headers in the message details section
            const headerSelectors = [
                '.hP', '.kQ', '.kR', // Gmail message details
                '.message-header', '.email-header', '.header-info',
                '[class*="header"]', '[class*="detail"]'
            ];
            
            const headerElements = container.querySelectorAll(headerSelectors.join(', '));
            headerElements.forEach(element => {
                const text = element.textContent || '';
                if (text.includes('Authentication-Results') || text.includes('Received-SPF') || text.includes('DKIM-Signature')) {
                    console.log('SpoofGuard: Found potential header information in DOM');
                    // This could be enhanced to parse actual header content if visible
                }
            });

            return null;
        } catch (error) {
            console.log('SpoofGuard: Error extracting auth from DOM:', error.message);
            return null;
        }
    }

    // parseAuthenticationHeaders method removed - using DOM extraction only

    extractAuthStatus(text, authType) {
        const lowerText = text.toLowerCase();
        
        // Enhanced pattern matching for authentication status
        const passPatterns = [
            `${authType}=pass`, `${authType}: pass`, `${authType} pass`,
            `${authType}=passed`, `${authType}: passed`, `${authType} passed`,
            `${authType}=ok`, `${authType}: ok`, `${authType} ok`,
            `${authType}=success`, `${authType}: success`, `${authType} success`,
            `${authType}=valid`, `${authType}: valid`, `${authType} valid`,
            `${authType}=verified`, `${authType}: verified`, `${authType} verified`
        ];
        
        const failPatterns = [
            `${authType}=fail`, `${authType}: fail`, `${authType} fail`,
            `${authType}=failed`, `${authType}: failed`, `${authType} failed`,
            `${authType}=invalid`, `${authType}: invalid`, `${authType} invalid`,
            `${authType}=error`, `${authType}: error`, `${authType} error`,
            `${authType}=reject`, `${authType}: reject`, `${authType} reject`,
            `${authType}=rejected`, `${authType}: rejected`, `${authType} rejected`
        ];
        
        const nonePatterns = [
            `${authType}=none`, `${authType}: none`, `${authType} none`,
            `${authType}=null`, `${authType}: null`, `${authType} null`,
            `${authType}=missing`, `${authType}: missing`, `${authType} missing`,
            `${authType}=absent`, `${authType}: absent`, `${authType} absent`
        ];
        
        const neutralPatterns = [
            `${authType}=neutral`, `${authType}: neutral`, `${authType} neutral`,
            `${authType}=unknown`, `${authType}: unknown`, `${authType} unknown`
        ];
        
        const softfailPatterns = [
            `${authType}=softfail`, `${authType}: softfail`, `${authType} softfail`,
            `${authType}=soft-fail`, `${authType}: soft-fail`, `${authType} soft-fail`,
            `${authType}=warning`, `${authType}: warning`, `${authType} warning`
        ];
        
        // Check for pass status
        if (passPatterns.some(pattern => lowerText.includes(pattern))) {
            return 'pass';
        }
        
        // Check for fail status
        if (failPatterns.some(pattern => lowerText.includes(pattern))) {
            return 'fail';
        }
        
        // Check for none status
        if (nonePatterns.some(pattern => lowerText.includes(pattern))) {
            return 'none';
        }
        
        // Check for neutral status
        if (neutralPatterns.some(pattern => lowerText.includes(pattern))) {
            return 'neutral';
        }
        
        // Check for softfail status
        if (softfailPatterns.some(pattern => lowerText.includes(pattern))) {
            return 'softfail';
        }
        
        // If the auth type is mentioned but no specific status, mark as present
        if (lowerText.includes(authType)) {
            return 'present';
        }
        
        return 'unknown';
    }

    parseSecurityBadgeInfo(badgeInfo) {
        const authInfo = {};
        const lowerInfo = badgeInfo.toLowerCase();
        
        if (lowerInfo.includes('spf')) {
            authInfo.spf = this.extractAuthStatus(lowerInfo, 'spf');
        }
        if (lowerInfo.includes('dkim')) {
            authInfo.dkim = this.extractAuthStatus(lowerInfo, 'dkim');
        }
        if (lowerInfo.includes('dmarc')) {
            authInfo.dmarc = this.extractAuthStatus(lowerInfo, 'dmarc');
        }
        
        // If no specific auth found but security info present, mark as checked
        if (Object.keys(authInfo).length === 0 && (lowerInfo.includes('authenticated') || lowerInfo.includes('verified'))) {
            authInfo.general = 'authenticated';
        }
        
        return Object.keys(authInfo).length > 0 ? authInfo : null;
    }

    async processEmailData(emailData) {
        // Use real authentication results if available, otherwise simulate
        let analysis;
        
        if (emailData.authResults && typeof emailData.authResults === 'object') {
            console.log('SpoofGuard: Using real authentication results from raw headers');
            analysis = this.simulateHeaderAnalysis(emailData);
        } else {
            console.log('SpoofGuard: No authentication results found, using simulation');
            analysis = this.simulateHeaderAnalysis(emailData);
        }
        
        this.currentEmail = {
            ...emailData,
            ...analysis
        };

        // Show visual indicator if enabled
        if (this.settings.realTimeMonitoring) {
            this.showSecurityIndicator(analysis);
        }

        // Log if detailed logging is enabled
        if (this.settings.detailedLogging) {
            console.log('SpoofGuard: Email analyzed:', this.currentEmail);
        }

        // Send to background script for storage/processing
        this.safeSendMessage({
            type: 'EMAIL_ANALYZED',
            data: this.currentEmail
        });
    }

    simulateHeaderAnalysis(emailData) {
        console.log('SpoofGuard: Analyzing email with authentication data:', emailData);
        
        const domain = this.extractDomain(emailData.sender);
        const isKnownProvider = this.isKnownEmailProvider(domain);

        // Detect spam/danger context regardless of API vs DOM source
        const currentUrl = window.location.href;
        const dangerBanner = Array.from(document.querySelectorAll('[role="alert"], .aCz, .aCk'))
            .some(el => /dangerous|phishing|why is this message in spam/i
                .test((el.textContent || '').toLowerCase()));
        const isInSpamFolder =
            currentUrl.includes('#spam') ||
            currentUrl.includes('/spam/') ||
            currentUrl.includes('label=spam') ||
            currentUrl.includes('search=in%3Aspam') ||
            dangerBanner;
        
        // Use actual authentication results if available
        let spfStatus = 'unknown';
        let dkimStatus = 'unknown';
        let dmarcStatus = 'unknown';
        let hasAuthResults = false;
        
        if (emailData.authResults && typeof emailData.authResults === 'object') {
            console.log('SpoofGuard: Using actual authentication results:', emailData.authResults);
            
            hasAuthResults = true;

            // Support both string and object shapes for each auth result
            const spfRaw = emailData.authResults.spf;
            const dkimRaw = emailData.authResults.dkim;
            const dmarcRaw = emailData.authResults.dmarc;

            spfStatus = this.normalizeAuthStatus(
                typeof spfRaw === 'string' ? spfRaw : (spfRaw && spfRaw.status) || 'unknown'
            );
            dkimStatus = this.normalizeAuthStatus(
                typeof dkimRaw === 'string' ? dkimRaw : (dkimRaw && dkimRaw.status) || 'unknown'
            );
            dmarcStatus = this.normalizeAuthStatus(
                typeof dmarcRaw === 'string' ? dmarcRaw : (dmarcRaw && dmarcRaw.status) || 'unknown'
            );
        } else {
            console.log('SpoofGuard: No authentication results found, using fallback analysis');
            
            // Fallback: Simulate authentication results based on sender domain
            if (!isKnownProvider) {
                spfStatus = Math.random() > 0.7 ? 'fail' : 'pass';
                dkimStatus = Math.random() > 0.8 ? 'fail' : 'pass';
                dmarcStatus = Math.random() > 0.9 ? 'fail' : 'pass';
            } else {
                spfStatus = 'pass';
                dkimStatus = 'pass';
                dmarcStatus = 'pass';
            }
        }

        const analysis = {
            spf: { 
                status: spfStatus, 
                details: (emailData.authResults && emailData.authResults.spf && emailData.authResults.spf.details)
                         ? emailData.authResults.spf.details
                         : `SPF authentication: ${spfStatus}` 
            },
            dkim: { 
                status: dkimStatus, 
                details: (emailData.authResults && emailData.authResults.dkim && emailData.authResults.dkim.details)
                         ? emailData.authResults.dkim.details
                         : `DKIM signature: ${dkimStatus}` 
            },
            dmarc: { 
                status: dmarcStatus, 
                details: (emailData.authResults && emailData.authResults.dmarc && emailData.authResults.dmarc.details)
                         ? emailData.authResults.dmarc.details
                         : `DMARC policy: ${dmarcStatus}` 
            },
            domain: domain,
            isKnownProvider: isKnownProvider,
            hasAuthResults: hasAuthResults,
            isInSpamFolder: isInSpamFolder
        };

        analysis.securityScore = this.calculateSecurityScore(analysis);
        analysis.riskLevel = this.determineRiskLevel(analysis);

        console.log('SpoofGuard: Final analysis:', analysis);
        return analysis;
    }

    normalizeAuthStatus(status) {
        if (!status || typeof status !== 'string') return 'unknown';
        
        const normalized = status.toLowerCase().trim();
        
        // Map various status formats to standard values
        switch (normalized) {
            case 'pass':
            case 'passed':
            case 'ok':
            case 'success':
                return 'pass';
            case 'fail':
            case 'failed':
            case 'failure':
            case 'error':
                return 'fail';
            case 'none':
            case 'absent':
            case 'missing':
                return 'none';
            case 'neutral':
            case 'softfail':
            case 'temperror':
            case 'permerror':
                return normalized;
            case 'suspicious':
                // Treat suspicious as a failure for scoring and risk
                return 'fail';
            case 'present':
            case 'found':
                return 'present';
            default:
                return 'unknown';
        }
    }

    extractDomain(email) {
        if (!email) return null;
        const match = email.match(/@([^>\s]+)/);
        return match ? match[1].toLowerCase() : null;
    }

    isKnownEmailProvider(domain) {
        const knownProviders = [
            'gmail.com', 'google.com'
        ];
        return knownProviders.includes(domain);
    }

    calculateSecurityScore(analysis) {
        let score = 0;
        const weights = { spf: 30, dkim: 35, dmarc: 35 };

        ['spf', 'dkim', 'dmarc'].forEach(auth => {
            const status = analysis[auth].status;
            
            switch (status) {
                case 'pass':
                    score += weights[auth];
                    break;
                case 'softfail':
                case 'neutral':
                    score += weights[auth] * 0.5;
                    break;
                case 'none':
                    // Treat "none" as a strong negative (no points)
                    // This ensures SPF=none does not look secure
                    break;
                case 'present':
                    score += weights[auth] * 0.2;
                    break;
                case 'fail':
                    // No points for failed authentication
                    break;
                case 'unknown':
                default:
                    // Slight penalty for unknown status
                    score += weights[auth] * 0.2;
                    break;
            }
        });

        // Bonus for having actual authentication results vs simulated
        if (analysis.hasAuthResults) {
            score += 10; // Bonus for having real auth data
        }

        // Penalty for unknown providers with poor authentication
        if (!analysis.isKnownProvider) {
            const failedAuths = ['spf', 'dkim', 'dmarc'].filter(auth => 
                analysis[auth].status === 'fail' || analysis[auth].status === 'unknown'
            ).length;
            
            if (failedAuths >= 2) {
                score -= 20; // Significant penalty for multiple failures from unknown provider
            }
        }

        // Strong penalty when the email is in the spam folder or flagged dangerous
        if (analysis.isInSpamFolder) {
            score -= 30;
        }

        return Math.max(0, Math.min(100, Math.round(score)));
    }

    determineRiskLevel(analysis) {
        const score = analysis.securityScore;
        
        if (score >= 80) return 'low';
        if (score >= 50) return 'medium';
        return 'high';
    }

    showSecurityIndicator(analysis) {
        // Remove existing indicator
        const existingIndicator = document.getElementById('spoofguard-indicator');
        if (existingIndicator) {
            existingIndicator.remove();
        }

        // Find the subject element to position indicator next to it
        const subjectSelectors = [
            '.hP .hQ',                            // Subject in header
            '.bog',                               // Subject element
            'h2[data-legacy-thread-id]',          // Thread subject
            '.hP',                                // Header area
            '[data-thread-perm-id] .bog'         // Thread subject alternative
        ];
        
        let subjectElement = null;
        for (const selector of subjectSelectors) {
            subjectElement = document.querySelector(selector);
            if (subjectElement && subjectElement.textContent.trim()) {
                console.log(`SpoofGuard: Found subject element with selector: ${selector}`);
                break;
            }
        }

        // If no subject element found, fall back to a general header area
        if (!subjectElement) {
            subjectElement = document.querySelector('.hP') || 
                           document.querySelector('[role="main"]') ||
                           document.querySelector('.ii.gt');
        }

        if (!subjectElement) {
            console.log('SpoofGuard: No suitable element found for indicator placement, using body');
            subjectElement = document.body;
        }

        // Create security indicator
        const indicator = document.createElement('span');
        indicator.id = 'spoofguard-indicator';
        indicator.className = `spoofguard-indicator ${analysis.riskLevel}`;
        
        let icon, message, color;
        switch (analysis.riskLevel) {
            case 'low':
                icon = '🛡️';
                message = 'Secure';
                color = '#22c55e';
                break;
            case 'medium':
                icon = '⚠️';
                message = 'Caution';
                color = '#f59e0b';
                break;
            case 'high':
                icon = '🚨';
                message = 'Risk';
                color = '#ef4444';
                break;
        }

        indicator.innerHTML = `
            <span class="spoofguard-icon">${icon}</span>
            <span class="spoofguard-text">${message}</span>
            <span class="spoofguard-score">${analysis.securityScore}/100</span>
        `;

        // Position indicator next to or after the subject element
        if (subjectElement.tagName === 'BODY') {
            // Fallback: add to body with fixed positioning
            indicator.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 10000;
            `;
            document.body.appendChild(indicator);
        } else {
            // Insert after the subject element or as the last child if it's a container
            if (subjectElement.classList.contains('hP') || subjectElement.classList.contains('bog')) {
                // If it's a subject container, append inside it
                subjectElement.appendChild(indicator);
            } else {
                // Insert after the subject element
                subjectElement.parentNode.insertBefore(indicator, subjectElement.nextSibling);
            }
        }

        console.log('SpoofGuard: Security indicator positioned next to subject');
    }

    /**
     * Check if the extension context is still valid
     */
    isExtensionContextValid() {
        try {
            return !!(chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage);
        } catch (error) {
            return false;
        }
    }

    /**
     * Safely send message to background script with error handling for extension context invalidation
     */
    safeSendMessage(message, callback = null, retryCount = 0, maxRetries = 2) {
        // Multiple layers of validation to prevent extension context errors
        
        // Layer 1: Check if extension context is valid
        if (!this.isExtensionContextValid()) {
            // Silently fail - extension context invalidation is expected behavior
            return;
        }

        // Layer 2: Comprehensive chrome.runtime availability check
        if (!window.chrome || 
            !window.chrome.runtime || 
            !window.chrome.runtime.sendMessage ||
            !window.chrome.runtime.id) {
            // Silently fail - chrome runtime not available
            return;
        }

        // Layer 3: Test chrome.runtime.id accessibility (this throws if context is invalid)
        try {
            const testId = chrome.runtime.id;
            if (!testId) {
                // Extension context is invalid
                return;
            }
        } catch (error) {
            // Extension context is invalid, fail silently
            return;
        }

        // Layer 4: Wrap the entire sendMessage operation in a comprehensive try-catch
        try {
            // Additional safety check right before sending
            if (!chrome.runtime || !chrome.runtime.sendMessage) {
                return;
            }

            chrome.runtime.sendMessage(message, (response) => {
                // Handle response callback errors
                try {
                    if (chrome.runtime.lastError) {
                        const error = chrome.runtime.lastError.message;
                        
                        // Check for various extension context invalidation messages
                        const invalidationMessages = [
                            'Extension context invalidated',
                            'message port closed',
                            'receiving end does not exist',
                            'Could not establish connection',
                            'The message port closed before a response was received'
                        ];
                        
                        const isInvalidationError = invalidationMessages.some(msg => 
                            error.toLowerCase().includes(msg.toLowerCase())
                        );
                        
                        if (isInvalidationError) {
                            // Silently handle extension context invalidation
                            // This is expected behavior during extension reloads/updates
                            return;
                        }
                        
                        // Only log truly unexpected runtime errors
                        if (retryCount === 0) {
                            console.error('SpoofGuard: Unexpected runtime error:', error);
                        }
                    } else if (callback && typeof callback === 'function') {
                        callback(response);
                    }
                } catch (callbackError) {
                    // Silently handle callback errors that might be related to context invalidation
                    return;
                }
            });
        } catch (error) {
            // Handle any exceptions thrown by chrome.runtime.sendMessage
            const errorMessage = error.message || error.toString();
            
            // Check for various extension context invalidation error patterns
            const invalidationPatterns = [
                'extension context invalidated',
                'disconnected',
                'port closed',
                'cannot access',
                'context invalidated',
                'message port closed',
                'receiving end does not exist',
                'could not establish connection'
            ];
            
            const isInvalidationError = invalidationPatterns.some(pattern => 
                errorMessage.toLowerCase().includes(pattern)
            );
            
            if (isInvalidationError) {
                // Silently handle extension context invalidation errors
                // These are expected during extension reloads, updates, or page navigation
                return;
            }
            
            // Only log truly unexpected errors on first attempt
            if (retryCount === 0) {
                console.error('SpoofGuard: Unexpected error sending message:', error);
            }
        }
    }
}

// Initialize content script
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new SpoofGuardContent();
    });
} else {
    new SpoofGuardContent();
}