export const QWEN_OAUTH_BASE_URL = 'https://chat.qwen.ai';
export const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`;
export const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
export const DEFAULT_QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';
export function getQwenOauthClientId(): string {
    return process.env.QWEN_OAUTH_CLIENT_ID || DEFAULT_QWEN_OAUTH_CLIENT_ID;
}
export const QWEN_OAUTH_SCOPE = 'openid profile email model.completion';
export const QWEN_OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
export const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const QWEN_SEARCH_PATH = '/api/v1/indices/plugin/web_search';
