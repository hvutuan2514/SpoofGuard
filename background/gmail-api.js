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

            // Chrome Extension OAuth flow — scopes come from manifest.oauth2.scopes
            const token = await new Promise((resolve, reject) => {
                chrome.identity.getAuthToken({ interactive: true }, (t) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(t);
                    }
                });
            });

            this.accessToken = token;
            this.tokenExpiry = Date.now() + (3600 * 1000);
            console.log('SpoofGuard: Gmail API authentication successful via getAuthToken');
            return true;

        } catch (error) {
            console.error('SpoofGuard: Gmail API authentication failed:', error);
            return false; // No WebAuthFlow fallback to avoid redirect_uri_mismatch
        } finally {
            this.isAuthenticating = false;
        }
    }

    async authenticateViaWebAuthFlow() {
        try {
            const manifest = chrome.runtime.getManifest();
            const clientId = manifest.oauth2?.client_id;
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
            spf: { status: 'unknown', details: 'SPF not found in headers' },
            dkim: { status: 'unknown', details: 'DKIM not found in headers' },
            dmarc: { status: 'unknown', details: 'DMARC not found in headers' }
        };

        try {
            // Check Authentication-Results header (most reliable)
            const authResults = headers['authentication-results'];
            if (authResults) {
                console.log('SpoofGuard: Found Authentication-Results header:', authResults);
                
                // Parse SPF
                const spfMatch = authResults.match(/spf=([^;\s]+)/i);
                if (spfMatch) {
                    results.spf = {
                        status: this.normalizeAuthStatus(spfMatch[1]),
                        details: `SPF: ${spfMatch[1]}`
                    };
                }

                // Parse DKIM
                const dkimMatch = authResults.match(/dkim=([^;\s]+)/i);
                if (dkimMatch) {
                    results.dkim = {
                        status: this.normalizeAuthStatus(dkimMatch[1]),
                        details: `DKIM: ${dkimMatch[1]}`
                    };
                }

                // Parse DMARC
                const dmarcMatch = authResults.match(/dmarc=([^;\s]+)/i);
                if (dmarcMatch) {
                    results.dmarc = {
                        status: this.normalizeAuthStatus(dmarcMatch[1]),
                        details: `DMARC: ${dmarcMatch[1]}`
                    };
                }
            }

            // Check individual headers as fallback
            if (results.spf.status === 'unknown' && headers['received-spf']) {
                const spfHeader = headers['received-spf'];
                if (spfHeader.includes('pass')) {
                    results.spf = { status: 'pass', details: 'SPF: pass (from Received-SPF header)' };
                } else if (spfHeader.includes('fail')) {
                    results.spf = { status: 'fail', details: 'SPF: fail (from Received-SPF header)' };
                }
            }

            // Check DKIM signature
            if (results.dkim.status === 'unknown' && (headers['dkim-signature'] || headers['x-google-dkim-signature'])) {
                results.dkim = { status: 'pass', details: 'DKIM: signature present' };
            }

            console.log('SpoofGuard: Extracted authentication results from headers:', results);
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