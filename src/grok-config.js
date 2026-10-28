// Shared Grok/xAI endpoints. Kept dependency-free so the store and the OAuth
// client can validate hosts without a circular import.
export const GROK_AUTHORIZE_URL = 'https://auth.x.ai/oauth2/authorize';
export const GROK_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
export const GROK_REDIRECT_URI = 'http://127.0.0.1:56121/callback';
export const GROK_CLI_HOST = 'cli-chat-proxy.grok.com';
export const GROK_CLI_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const GROK_API_BASE_URL = 'https://api.x.ai/v1';

export function grokBaseAllowed(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === GROK_CLI_HOST || host === 'api.x.ai' || host.endsWith('.api.x.ai');
}
