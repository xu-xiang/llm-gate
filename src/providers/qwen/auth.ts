import crypto from 'node:crypto';
import { logger } from '../../core/logger';
import { IStorage } from '../../core/storage';
import {
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
    private storage: IStorage;
    private credsKey: string;
    private clientId: string;
    private memoryCredentials?: QwenCredentials;

    constructor(storage: IStorage, credsKey: string, clientId: string) {
        this.storage = storage;
        this.credsKey = credsKey.startsWith('./') ? credsKey.substring(2) : credsKey;
        this.clientId = clientId;
    }

    private getCandidateKeys(): string[] {
        return this.credsKey.startsWith('./') ? [this.credsKey] : [this.credsKey, `./${this.credsKey}`];
    }

    public clearCache() {
        this.memoryCredentials = undefined;
    }

    private async loadCredentials(): Promise<QwenCredentials | null> {
        try {
            for (const key of this.getCandidateKeys()) {
                const data = await this.storage.get(key);
                if (data && data.access_token) {
                    this.memoryCredentials = data;
                    return data;
                }
            }
        } catch (error) {
            logger.warn(`Failed to read credentials from storage key ${this.credsKey}:`, error);
        }
        return null;
    }

    private async saveCredentials(creds: QwenCredentials): Promise<void> {
        try {
            await this.storage.set(this.credsKey, creds);
            if (this.credsKey.startsWith('./')) {
                await this.storage.delete(this.credsKey.substring(2));
            } else {
                await this.storage.delete(`./${this.credsKey}`);
            }
            this.memoryCredentials = creds;
            logger.info(`Credentials saved successfully for ${this.credsKey}.`);
        } catch (error) {
            logger.error(`Failed to save credentials to storage key ${this.credsKey}`, error);
            throw error;
        }
    }

    public async startDeviceAuth(codeChallenge: string): Promise<DeviceAuthorizationResponse> {
        const bodyData = {
            client_id: this.clientId,
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
    }

    public async exchangeDeviceCode(deviceCode: string, codeVerifier: string): Promise<QwenCredentials | 'pending'> {
        const bodyData = {
            grant_type: QWEN_OAUTH_GRANT_TYPE,
            client_id: this.clientId,
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
            if (errorData?.error === 'authorization_pending' || errorData?.error === 'slow_down') {
                return 'pending';
            }
            throw new Error(errorData?.error_description || errorData?.error || 'Unknown error');
        }

        return {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            token_type: data.token_type,
            resource_url: data.resource_url,
            expiry_date: Date.now() + (data.expires_in * 1000),
            scope: data.scope
        };
    }

    public async refreshToken(refreshToken: string): Promise<QwenCredentials> {
        const lockName = `token_refresh:${this.credsKey}`;
        const lockToken = await this.storage.acquireLock(lockName, 60);
        
        if (!lockToken) {
            logger.info(`Another instance is refreshing token for ${this.credsKey}. Waiting...`);
            return await this.waitForTokenUpdate(refreshToken);
        }

        try {
            const latest = await this.loadCredentials();
            if (latest && latest.access_token && latest.refresh_token !== refreshToken) {
                 return latest;
            }

            logger.info(`Performing real token refresh for ${this.credsKey}...`);
            const bodyData = {
                grant_type: 'refresh_token',
                client_id: this.clientId,
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
                 if (response.status === 400 || response.status === 401) {
                     logger.error(`Refresh token has expired or is invalid for ${this.credsKey}. Manual login required.`);
                     throw new Error('AUTH_EXPIRED');
                 }
                 throw new Error(`HTTP ${response.status}: ${errorText}`);
             }

             let data: any;
             try {
                 data = await response.json() as any;
             } catch (e) {
                 logger.error(`Token refresh response is not valid JSON for ${this.credsKey}. Manual login required.`);
                 throw new Error('AUTH_EXPIRED');
             }
             const creds: QwenCredentials = {
                access_token: data.access_token,
                refresh_token: data.refresh_token || refreshToken,
                token_type: data.token_type,
                resource_url: data.resource_url || this.memoryCredentials?.resource_url,
                expiry_date: Date.now() + (data.expires_in * 1000),
                scope: data.scope,
                alias: this.memoryCredentials?.alias // Preserve alias during refresh
            };

            await this.saveCredentials(creds);
            return creds;
        } finally {
            await this.storage.releaseLock(lockName, lockToken);
        }
    }

    private async waitForTokenUpdate(oldRefreshToken: string): Promise<QwenCredentials> {
        const maxRetries = 30;
        for (let i = 0; i < maxRetries; i++) {
            await new Promise(r => setTimeout(r, 500));
            const creds = await this.loadCredentials();
            if (creds && creds.refresh_token !== oldRefreshToken) {
                return creds;
            }
        }
        throw new Error('Timeout or failure waiting for token update');
    }

    // FIX: Fallback to file ID if alias is missing
    public getCachedAlias(): string | undefined {
        return this.memoryCredentials?.alias || this.credsKey.replace('qwen_creds_', '').replace('oauth_creds_', '').replace('.json', '');
    }

    public async probeTokenStatus(creds: QwenCredentials): Promise<number | null> {
        try {
            const baseUrl = creds.resource_url || 'portal.qwen.ai';
            let normalizedUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
            if (normalizedUrl.endsWith('/')) normalizedUrl = normalizedUrl.slice(0, -1);
            const url = `${normalizedUrl}/v1/chat/completions`;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            try {
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
                    }),
                    signal: controller.signal
                });
                return response.status;
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (e) {
            return null;
        }
    }

    public async checkTokenValidity(creds: QwenCredentials): Promise<boolean> {
        const status = await this.probeTokenStatus(creds);
        return status === 200;
    }

    public async getValidCredentials(): Promise<QwenCredentials> {
        const creds = await this.loadCredentials();
        if (!creds) throw new Error('No credentials found.');

        const now = Date.now();
        const expiresAt = creds.expiry_date || 0;
        
        if (expiresAt && now >= expiresAt - 300000) {
            return await this.refreshToken(creds.refresh_token);
        }
        return creds;
    }
}
