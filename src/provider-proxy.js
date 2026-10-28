// Per-provider outbound HTTP proxy. Only HTTP(S) CONNECT proxies are supported,
// and the configuration is validated by Store.upsert.
import crypto from 'node:crypto';
import { ProxyAgent } from 'undici';

const agents = new Map();

export function parseProxyUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.toString().replace(/\/$/, '');
}

export function normalizeNoProxy(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  const list = [];
  for (const raw of parts) {
    const host = String(raw ?? '').trim().toLowerCase().replace(/^\*?\./, '');
    if (!host) continue;
    if (host.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
    if (!list.includes(host)) list.push(host);
    if (list.length > 50) return null;
  }
  return list;
}

export function proxyBypass(provider, hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  return (provider?.noProxy || []).some(rule => host === rule || host.endsWith(`.${rule}`));
}

export function proxyDispatcher(provider, unseal = value => value) {
  if (!provider?.proxyEnabled || !provider.proxyUrl) return undefined;
  const username = String(provider.proxyUsername || '');
  const password = provider.proxyPassword ? String(unseal(provider.proxyPassword) || '') : '';
  const key = crypto.createHash('sha256')
    .update(`${provider.proxyUrl}\u0000${username}\u0000${password}`)
    .digest('hex');
  let agent = agents.get(key);
  if (!agent) {
    const token = username || password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : undefined;
    agent = new ProxyAgent({ uri: provider.proxyUrl, ...(token ? { token } : {}) });
    agents.set(key, agent);
  }
  return agent;
}

// A provider either points at a saved proxy (proxyId) or keeps inline settings.
export function proxySettingsFor(store, provider) {
  if (provider?.proxyId) {
    const saved = store?.data?.proxies?.find(item => item.id === provider.proxyId);
    if (!saved || saved.enabled === false) return { enabled: false };
    return { enabled: true, url: saved.url, username: saved.username || '', password: saved.password || '', noProxy: saved.noProxy || [] };
  }
  return {
    enabled: Boolean(provider?.proxyEnabled && provider.proxyUrl),
    url: provider?.proxyUrl || '', username: provider?.proxyUsername || '',
    password: provider?.proxyPassword || '', noProxy: provider?.noProxy || []
  };
}

export function dispatcherForProvider(store, provider, targetUrl) {
  const settings = proxySettingsFor(store, provider);
  if (!settings.enabled || !settings.url) return undefined;
  let hostname;
  try { hostname = new URL(String(targetUrl)).hostname; } catch { return undefined; }
  if (proxyBypass({ noProxy: settings.noProxy }, hostname)) return undefined;
  return proxyDispatcher({ proxyEnabled: true, proxyUrl: settings.url, proxyUsername: settings.username, proxyPassword: settings.password }, value => store.unseal(value));
}

// Undefined means a direct connection, which fetch treats as the default dispatcher.
export function dispatcherFor(provider, targetUrl, unseal) {
  if (!provider?.proxyEnabled || !provider.proxyUrl) return undefined;
  let hostname;
  try { hostname = new URL(String(targetUrl)).hostname; } catch { return undefined; }
  if (proxyBypass(provider, hostname)) return undefined;
  return proxyDispatcher(provider, unseal);
}

export async function clearProxyAgents() {
  const pending = [...agents.values()];
  agents.clear();
  await Promise.allSettled(pending.map(agent => agent.close()));
}
