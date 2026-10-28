// Saved-proxy connectivity probe: one CONNECT tunnel plus a real HTTPS request.
import { ProxyAgent } from 'undici';

export const PROXY_PROBE_URL = 'https://auth.x.ai/.well-known/openid-configuration';

export async function testSavedProxy(proxy, unseal, { fetchImpl = fetch, signal, url = PROXY_PROBE_URL } = {}) {
  const username = String(proxy?.username || '');
  const password = proxy?.password ? String(unseal(proxy.password) || '') : '';
  const token = username || password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : undefined;
  const agent = new ProxyAgent({ uri: proxy.url, ...(token ? { token } : {}) });
  const started = Date.now();
  try {
    const timeout = AbortSignal.timeout(15000);
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'error',
      headers: { accept: 'application/json', 'user-agent': 'model-harbor-proxy-check/0.1.0' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      dispatcher: agent
    });
    await response.body?.cancel();
    return { ok: true, status: response.status, ms: Date.now() - started, target: url };
  } catch (error) {
    const code = error?.cause?.code || error?.code || error?.name || 'network_error';
    return { ok: false, status: 0, ms: Date.now() - started, target: url, message: String(code).slice(0, 120) };
  } finally {
    await agent.close().catch(() => {});
  }
}
