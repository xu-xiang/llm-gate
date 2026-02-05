export interface QwenCredentials {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in?: number;
    scope?: string;
    created_at?: number;
    resource_url?: string;
    expiry_date?: number; // Optional: Some clients use this instead of created_at + expires_in
    alias?: string; // User-defined name for the account
}

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

export interface WebSearchResponse {
    results: SearchResult[];
}

export interface DeviceAuthorizationResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
}

export interface QwenErrorResponse {
    error: string;
    error_description?: string;
}
