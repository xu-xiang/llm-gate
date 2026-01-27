import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../../core/logger';
import {
    getQwenOauthClientId,
    QWEN_OAUTH_DEVICE_CODE_ENDPOINT,
    QWEN_OAUTH_GRANT_TYPE,
    QWEN_OAUTH_SCOPE,
    QWEN_OAUTH_TOKEN_ENDPOINT
} from './constants';
import { DeviceAuthorizationResponse, QwenCredentials, QwenErrorResponse } from './types';

export function generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(codeVerifier: string): string {
    const hash = crypto.createHash('sha256');
    hash.update(codeVerifier);
    return hash.digest('base64url');
}

function objectToUrlEncoded(data: Record<string, string>): string {
    return Object.keys(data)
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
        .join('&');
}

export class QwenAuthManager {
    private credsPath: string;
    private memoryCredentials?: QwenCredentials;
    private lastFileModTime: number = 0;

    constructor(credsPath: string) {
        this.credsPath = credsPath;
    }

    public getCredsPath(): string {
        return this.credsPath;
    }

    private async loadCredentials(): Promise<QwenCredentials | null> {
        try {
            if (await fs.pathExists(this.credsPath)) {
                const stats = await fs.stat(this.credsPath);
                
                if (this.memoryCredentials && stats.mtimeMs <= this.lastFileModTime) {
                    return this.memoryCredentials;
                }

                logger.info(`Loading credentials from disk: ${this.credsPath}`);
                const data = await fs.readJson(this.credsPath);
                
                if (!data.access_token) {
                    logger.warn('Invalid credentials in file: missing access_token');
                    return null;
                }
                
                this.memoryCredentials = data;
                this.lastFileModTime = stats.mtimeMs;
                return data;
            }
        } catch (error) {
            logger.warn(`Failed to read credentials from ${this.credsPath}:`, error);
        }
        return null;
    }

    private async saveCredentials(creds: QwenCredentials): Promise<void> {
        const tempPath = `${this.credsPath}.tmp.${crypto.randomUUID()}`;
        try {
            await fs.ensureDir(path.dirname(this.credsPath));
            await fs.writeJson(tempPath, creds, { spaces: 2 });
            await fs.rename(tempPath, this.credsPath);
            
            const stats = await fs.stat(this.credsPath);
            this.memoryCredentials = creds;
            this.lastFileModTime = stats.mtimeMs;
            logger.info('Credentials saved successfully.');
        } catch (error) {
            logger.error(`Failed to save credentials atomically to ${this.credsPath}`, error);
            if (await fs.pathExists(tempPath)) {
                await fs.unlink(tempPath).catch(() => {});
            }
            throw error;
        }
    }

    public async startDeviceAuth(codeChallenge: string): Promise<DeviceAuthorizationResponse> {
        try {
            const bodyData = {
                client_id: getQwenOauthClientId(),
                scope: QWEN_OAUTH_SCOPE,
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
            };

            const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                body: objectToUrlEncoded(bodyData)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            return await response.json() as DeviceAuthorizationResponse;
        } catch (error: any) {
             logger.error('Device auth request failed', error);
             throw new Error('Failed to initiate device authentication');
        }
    }

    public async pollForToken(deviceCode: string, codeVerifier: string, interval: number): Promise<QwenCredentials> {
        // Use server provided interval or default to 5 seconds
        const safeInterval = (typeof interval === 'number' && !isNaN(interval)) ? interval : 5;
        const intervalMs = safeInterval * 1000;
        
        return new Promise<QwenCredentials>((resolve, reject) => {
            const poll = async () => {
                try {
                    const bodyData = {
                        grant_type: QWEN_OAUTH_GRANT_TYPE,
                        client_id: getQwenOauthClientId(),
                        device_code: deviceCode,
                        code_verifier: codeVerifier
                    };

                    const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Accept': 'application/json'
                        },
                        body: objectToUrlEncoded(bodyData)
                    });

                    const data = await response.json() as any;

                    if (!response.ok) {
                        const errorData = data as QwenErrorResponse;
                        if (errorData?.error === 'authorization_pending') {
                            setTimeout(poll, intervalMs);
                            return;
                        } else if (errorData?.error === 'slow_down') {
                            setTimeout(poll, intervalMs + 2000);
                            return;
                        } else {
                            reject(new Error(errorData?.error_description || errorData?.error || 'Unknown error during polling'));
                            return;
                        }
                    }

                    const creds: QwenCredentials = {
                        access_token: data.access_token,
                        refresh_token: data.refresh_token,
                        token_type: data.token_type,
                        resource_url: data.resource_url,
                        expiry_date: Date.now() + (data.expires_in * 1000),
                        scope: data.scope
                    };

                    await this.saveCredentials(creds);
                    resolve(creds);

                } catch (error: any) {
                    reject(new Error(error.message));
                }
            };
            poll();
        });
    }

    public async refreshToken(refreshToken: string): Promise<QwenCredentials> {
        logger.info('Refreshing Qwen token...');
        try {
            const bodyData = {
                grant_type: 'refresh_token',
                client_id: getQwenOauthClientId(),
                refresh_token: refreshToken
            };

            const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                body: objectToUrlEncoded(bodyData)
            });

             if (!response.ok) {
                 const errorText = await response.text();
                 throw new Error(`HTTP ${response.status}: ${errorText}`);
             }

             const data = await response.json() as any;
             
             const creds: QwenCredentials = {
                access_token: data.access_token,
                refresh_token: data.refresh_token || refreshToken,
                token_type: data.token_type,
                resource_url: data.resource_url || this.memoryCredentials?.resource_url,
                expiry_date: Date.now() + (data.expires_in * 1000),
                scope: data.scope
            };

            await this.saveCredentials(creds);
            logger.info('Token refreshed successfully.');
            return creds;
        } catch (error: any) {
            logger.error('Refresh token failed', error);
            throw new Error('Failed to refresh token');
        }
    }

    public async checkTokenValidity(creds: QwenCredentials): Promise<boolean> {
        try {
            const baseUrl = creds.resource_url || 'portal.qwen.ai';
            const suffix = '/v1';
            let normalizedUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
            if (normalizedUrl.endsWith('/')) normalizedUrl = normalizedUrl.slice(0, -1);
            if (!normalizedUrl.endsWith(suffix)) normalizedUrl = `${normalizedUrl}${suffix}`;
            
            const url = `${normalizedUrl}/chat/completions`;

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${creds.access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'coder-model',
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1
                })
            });

            if (response.ok) return true;
            if (response.status === 401) return false;
            
            return true;
        } catch (e) {
            logger.warn('Token validity check failed (network issue)', e);
            return true; 
        }
    }

    public async getValidCredentials(): Promise<QwenCredentials> {
        let creds = await this.loadCredentials();

        if (!creds) {
            throw new Error('No credentials found.');
        }

        const now = Date.now();
        let expiresAt = creds.expiry_date || 0;
        
        if (!expiresAt && creds.expires_in && creds.created_at) {
            expiresAt = creds.created_at + (creds.expires_in * 1000);
        }

        if (expiresAt && now >= expiresAt - 300000) {
            return await this.refreshToken(creds.refresh_token);
        }

        return creds;
    }

    public async authenticateInteractive(): Promise<QwenCredentials> {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const authData = await this.startDeviceAuth(codeChallenge);
        
        console.log('\n==================================================');
        console.log('      Qwen API Gateway Authentication Required');
        console.log('==================================================');
        console.log(`Target File: ${this.credsPath}`); // 增加这一行
        console.log(`\n1. Open this URL in your browser:\n   ${authData.verification_uri_complete}`);
        console.log(`\n2. Verify the code matches:\n   ${authData.user_code}`);
        console.log('\nWaiting for you to approve in the browser...');
        console.log('==================================================\n');

        return this.pollForToken(authData.device_code, codeVerifier, authData.interval);
    }
}
