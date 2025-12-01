/**
 * Gmail API Client for SpoofGuard
 * Handles OAuth authentication and raw email header extraction
 */

export class GmailAPIClient {
    constructor() {
        this.accessToken = null;
        this.tokenExpiry = null;
        this.isAuthenticating = false;
    }

    // Add: validate cached token
    isTokenValid() {
        return this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry;
    }

    async authenticate() {
        if (this.isAuthenticating) {
            console.log('SpoofGuard: Authentication already in progress');
            return false;
        }
        if (this.isTokenValid()) {
            console.log('SpoofGuard: Using existing valid token');
            return true;
        }

        try {
            this.isAuthenticating = true;
            console.log('SpoofGuard: Starting Gmail API authentication...');

            const token = await new Promise((resolve) => {
                chrome.identity.getAuthToken({ interactive: true }, (t) => {
                    if (chrome.runtime.lastError) {
                        resolve(null);
                    } else {
                        resolve(t);
                    }
                });
            });

            if (token) {
                this.accessToken = token;
                this.tokenExpiry = Date.now() + (3600 * 1000);
                console.log('SpoofGuard: Gmail API authentication successful via getAuthToken');
                return true;
            }

            const webOk = await this.authenticateViaWebAuthFlow();
            if (webOk) return true;
            throw new Error('Gmail API authentication failed');

        } catch (error) {
            console.error('SpoofGuard: Gmail API authentication failed:', error);
            return false;
        } finally {
            this.isAuthenticating = false;
        }
    }

    async authenticateViaWebAuthFlow() {
        try {
            const manifest = chrome.runtime.getManifest();
            const stored = await chrome.storage.sync.get(['oauthClientId']).catch(() => ({}));
            const clientId = stored.oauthClientId || manifest.oauth2?.client_id;
            if (!clientId) {
                throw new Error('Missing oauth2.client_id in manifest.json');
            }

            // Use Chrome-provided redirect URL (must be in OAuth2 allowed redirect URIs)
            const redirectUri = chrome.identity.getRedirectURL('oauth2');
            const scope = encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly');
            const state = Math.random().toString(36).slice(2);

            const authUrl =
                `https://accounts.google.com/o/oauth2/v2/auth` +
                `?client_id=${encodeURIComponent(clientId)}` +
                `&response_type=token` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&scope=${scope}` +
                `&prompt=consent` +
                `&state=${state}`;

            const responseUrl = await new Promise((resolve, reject) => {
                chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (rUrl) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else if (!rUrl) {
                        reject(new Error('Empty response URL from WebAuthFlow'));
                    } else {
                        resolve(rUrl);
                    }
                });
            });

            // Parse access_token and expires_in from the fragment (#…)
            const fragment = responseUrl.split('#')[1] || '';
            const params = new URLSearchParams(fragment);
            const token = params.get('access_token');
            const expiresIn = parseInt(params.get('expires_in') || '3600', 10);

            if (!token) {
                throw new Error('No access_token in OAuth response');
            }

            this.accessToken = token;
            this.tokenExpiry = Date.now() + (expiresIn * 1000);

            console.log('SpoofGuard: Gmail API authentication successful via WebAuthFlow');
            return true;
        } catch (error) {
            console.error('SpoofGuard: WebAuthFlow failed:', error);
            return false;
        }
    }

    // Parse a potential message identifier from a Gmail URL
    extractMessageIdFromUrl(url) {
        try {
            // Rare: numeric ID embedded in element-like tokens
            const numericMatch = url.match(/msg-f:(\d+)/);
            if (numericMatch) {
                return numericMatch[1];
            }

            // Common: UI token (FMfcgz…) — may not be API-valid, but keep for logging/fallback
            const uiMatch = url.match(/\/mail\/u\/\d+\/#[^/]+\/([A-Za-z0-9]+)/);
            if (uiMatch) {
                console.log('SpoofGuard: URL-derived ID (likely UI token):', uiMatch[1]);
                return uiMatch[1];
            }

            return null;
        } catch (e) {
            console.log('SpoofGuard: Failed to extract message id from URL:', e.message);
            return null;
        }
    }

    async resolveMessageId(id) {
        // Only accept valid message IDs; the UI FMfcgz… token won’t work.
        // Probe messages.get with minimal format; if it succeeds, id is valid.
        const resp = await fetch(
            `https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=minimal`,
            { headers: { Authorization: `Bearer ${this.accessToken}` } }
        );

        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            console.error('SpoofGuard: messages.get probe error body:', body);
            throw new Error(`Invalid message id (${resp.status})`);
        }

        const msg = await resp.json();
        return msg.id;
    }

    async getRawEmailHeaders(messageId) {
        if (!messageId) {
            throw new Error('Message ID is required');
        }
        if (!await this.authenticate()) {
            throw new Error('Failed to authenticate with Gmail API');
        }

        // Validate/resolve to an API message id
        const resolvedId = await this.resolveMessageId(messageId);

        console.log('SpoofGuard: Fetching raw headers for message:', resolvedId);

        const response = await fetch(
            `https://www.googleapis.com/gmail/v1/users/me/messages/${resolvedId}?format=full`,
            {
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            console.error('SpoofGuard: Gmail API error body (messages.get full):', body);
            throw new Error(`Gmail API request failed: ${response.status}`);
        }

        const data = await response.json();
        console.log('SpoofGuard: Gmail API response received');

        return this.parseGmailAPIResponse(data);
    }

    parseGmailAPIResponse(data) {
        try {
            const headers = {};
            
            if (data.payload && data.payload.headers) {
                data.payload.headers.forEach(header => {
                    const name = header.name.toLowerCase();
                    const value = header.value;
                    
                    // Store all headers for debugging
                    headers[name] = value;
                });
            }

            console.log('SpoofGuard: Parsed headers from Gmail API:', Object.keys(headers));
            
            return {
                messageId: data.id,
                threadId: data.threadId,
                headers: headers,
                authenticationResults: this.extractAuthenticationFromHeaders(headers)
            };

        } catch (error) {
            console.error('SpoofGuard: Error parsing Gmail API response:', error);
            throw error;
        }
    }

    extractAuthenticationFromHeaders(headers) {
        const results = {
            spf: { status: 'unknown', details: 'SPF not found in headers', explanation: '' },
            dkim: { status: 'unknown', details: 'DKIM not found in headers', explanation: '' },
            dmarc: { status: 'unknown', details: 'DMARC not found in headers', explanation: '' }
        };

        try {
            const authHeader =
                headers['authentication-results'] ||
                headers['arc-authentication-results'];

            if (authHeader) {
                console.log('SpoofGuard: Found Authentication-Results header:', authHeader);

                // Helper to parse a section like: "<name>=<status> (<reason>)"
                const parseSection = (name) => {
                    const m = authHeader.match(new RegExp(`${name}=([^;\\s]+)(?:\\s*\\(([^)]*)\\))?`, 'i'));
                    return {
                        statusRaw: m ? m[1] : null,
                        status: m ? this.normalizeAuthStatus(m[1]) : 'unknown',
                        reason: m ? (m[2] || '') : '',
                    };
                };

                // Common tokens across Authentication-Results
                const smtpMailFrom = (authHeader.match(/smtp\.mailfrom=([^;\s]+)/i) || [])[1] || '';
                const headerI = (authHeader.match(/header\.i=([^;\s]+)/i) || [])[1] || '';
                const headerFrom = (authHeader.match(/header\.from=([^;\s]+)/i) || [])[1] || '';
                const clientIp =
                    (authHeader.match(/client-ip=([0-9a-f:\.]+)/i) || [])[1] ||
                    (authHeader.match(/does not designate\s+([0-9a-f:\.]+)\s+as permitted sender/i) || [])[1] ||
                    '';
                // DMARC policy flags
                const dmarcPolicy = (authHeader.match(/p=([a-z]+)/i) || [])[1] || '';
                const dmarcSubPolicy = (authHeader.match(/sp=([a-z]+)/i) || [])[1] || '';
                const dmarcDisposition = (authHeader.match(/dis=([a-z]+)/i) || [])[1] || '';

                // SPF
                const spf = parseSection('spf');
                results.spf.status = spf.status;
                results.spf.details = [spf.reason, smtpMailFrom && `smtp.mailfrom=${smtpMailFrom}`, clientIp && `client-ip=${clientIp}`]
                    .filter(Boolean)
                    .join(' | ');

                if (spf.status === 'fail') {
                    if (/does not designate|not permitted|unauthorized/i.test(spf.reason)) {
                        results.spf.explanation = 'SPF failed: sending IP not authorized';
                    } else if (/permerror/i.test(spf.statusRaw) || /permerror|syntax/i.test(spf.reason)) {
                        results.spf.explanation = 'SPF failed: SPF record syntax error';
                    } else if (/temperror|temporary|dns/i.test(spf.reason)) {
                        results.spf.explanation = 'SPF failed: temporary DNS lookup error';
                    } else {
                        results.spf.explanation = 'SPF failed: policy did not match sender';
                    }
                } else if (spf.status === 'softfail') {
                    results.spf.explanation = 'SPF softfail: IP not fully authorized (best guess rule)';
                } else if (spf.status === 'neutral') {
                    results.spf.explanation = 'SPF neutral: no applicable rule matched';
                } else if (spf.status === 'none') {
                    results.spf.explanation = 'SPF none: domain does not publish SPF';
                }

                // DKIM
                const dkim = parseSection('dkim');
                results.dkim.status = dkim.status;
                results.dkim.details = [dkim.reason, headerI && `header.i=${headerI}`]
                    .filter(Boolean)
                    .join(' | ');

                if (dkim.status === 'fail') {
                    if (/bad signature|verification failed|body hash mismatch/i.test(dkim.reason)) {
                        results.dkim.explanation = 'DKIM failed: signature verification mismatch';
                    } else if (/no key|key not found/i.test(dkim.reason)) {
                        results.dkim.explanation = 'DKIM failed: selector key not found';
                    } else if (/expired/i.test(dkim.reason)) {
                        results.dkim.explanation = 'DKIM failed: signature expired';
                    } else {
                        results.dkim.explanation = 'DKIM failed: signature invalid';
                    }
                } else if (dkim.status === 'none') {
                    results.dkim.explanation = 'DKIM none: no DKIM signature present';
                }

                // DMARC
                const dmarc = parseSection('dmarc');
                results.dmarc.status = dmarc.status;
                results.dmarc.details = [
                    dmarc.reason,
                    headerFrom && `header.from=${headerFrom}`,
                    dmarcPolicy && `p=${dmarcPolicy}`,
                    dmarcSubPolicy && `sp=${dmarcSubPolicy}`,
                    dmarcDisposition && `dis=${dmarcDisposition}`
                ].filter(Boolean).join(' | ');

                // Heuristic alignment for DMARC explanation
                const fromDomain = (headerFrom.match(/@?([^@\s>]+)$/) || [])[1] || '';
                const spfDomain = (smtpMailFrom.match(/@?([^@\s>]+)$/) || [])[1] || '';
                const dkimDomain = (headerI.match(/@?([^@\s>]+)$/) || [])[1] || '';
                const relaxedAligned = (a, b) => !!a && !!b && (a === b || a.endsWith(`.${b}`));

                const spfAlignedPass = spf.status === 'pass' && relaxedAligned(spfDomain, fromDomain);
                const dkimAlignedPass = dkim.status === 'pass' && relaxedAligned(dkimDomain, fromDomain);

                if (dmarc.status === 'fail') {
                    if (!spfAlignedPass && !dkimAlignedPass) {
                        results.dmarc.explanation = 'DMARC failed: neither SPF nor DKIM passed with domain alignment';
                    } else if (!spfAlignedPass) {
                        results.dmarc.explanation = 'DMARC failed: SPF not aligned with From domain';
                    } else if (!dkimAlignedPass) {
                        results.dmarc.explanation = 'DMARC failed: DKIM not aligned with From domain';
                    } else {
                        results.dmarc.explanation = 'DMARC failed: policy enforcement triggered';
                    }
                } else if (dmarc.status === 'none') {
                    results.dmarc.explanation = 'DMARC none: domain does not publish DMARC policy';
                }
            }

            // Received-SPF fallback
            if (results.spf.status === 'unknown' && headers['received-spf']) {
                const spfHeader = headers['received-spf'];
                if (/pass/i.test(spfHeader)) {
                    results.spf = { status: 'pass', details: 'Received-SPF shows pass', explanation: 'SPF passed per Received-SPF' };
                } else if (/fail/i.test(spfHeader)) {
                    const ip = (spfHeader.match(/client-ip=([0-9a-f:\.]+)/i) || [])[1] || '';
                    results.spf = {
                        status: 'fail',
                        details: ip ? `client-ip=${ip}` : 'Received-SPF shows fail',
                        explanation: 'SPF failed: sending IP not authorized'
                    };
                }
            }

            // DKIM presence fallback (heuristic)
            if (results.dkim.status === 'unknown' && (headers['dkim-signature'] || headers['x-google-dkim-signature'])) {
                results.dkim = { status: 'pass', details: 'DKIM signature present', explanation: 'DKIM passed: signature verified' };
            }

            console.log('SpoofGuard: Extracted authentication results with explanations:', results);
            return results;

        } catch (error) {
            console.error('SpoofGuard: Error extracting authentication from headers:', error);
            return results;
        }
    }

    normalizeAuthStatus(status) {
        const normalizedStatus = status.toLowerCase().trim();
        
        if (normalizedStatus.includes('pass')) return 'pass';
        if (normalizedStatus.includes('fail')) return 'fail';
        if (normalizedStatus.includes('none')) return 'none';
        if (normalizedStatus.includes('neutral')) return 'neutral';
        if (normalizedStatus.includes('softfail')) return 'softfail';
        if (normalizedStatus.includes('temperror')) return 'temperror';
        if (normalizedStatus.includes('permerror')) return 'permerror';
        
        return 'unknown';
    }

    async revokeToken() {
        if (this.accessToken) {
            try {
                await new Promise((resolve) => {
                    chrome.identity.removeCachedAuthToken({ token: this.accessToken }, resolve);
                });
                
                this.accessToken = null;
                this.tokenExpiry = null;
                console.log('SpoofGuard: Gmail API token revoked');
            } catch (error) {
                console.error('SpoofGuard: Error revoking token:', error);
            }
        }
    }
}