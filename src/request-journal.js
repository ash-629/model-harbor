import fs from 'node:fs';
import path from 'node:path';

// A bounded, content-free journal. Never persist raw upstream errors, prompts,
// tool arguments, credentials, or arbitrary adapter metadata.
export class RequestJournal {
  constructor(dir, { maxEntries = 5000, maxBytes = 8 * 1024 * 1024, days = 7 } = {}) {
    this.file = path.join(dir, 'requests.jsonl'); this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.days = days;
    this.rows = []; this.pending = Promise.resolve(); this.error = null;
    try {
      if (fs.statSync(this.file).size <= maxBytes) this.rows = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [this.clean(JSON.parse(line))]; } catch { return []; } });
    } catch (e) { if (e.code !== 'ENOENT') this.error = 'Request history could not be loaded'; }
    this.prune();
  }
  clean(value) {
    const text = v => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) : undefined;
    const number = v => Number.isFinite(v) && v >= 0 ? v : null;
    const m = value.tokenMetrics || {}, usage = m.usage;
    const numeric = (object, keys) => object ? Object.fromEntries(keys.filter(k => Number.isFinite(object[k])).map(k => [k, number(object[k])])) : undefined;
    return { time: text(value.time) || new Date().toISOString(), requestId: text(value.requestId), sourceIp: text(value.sourceIp), model: text(value.model),
      endpoint: text(value.endpoint), status: number(value.status), duration: number(value.duration), errorCode: text(value.errorCode),
      tokenMetrics: { provider: text(m.provider), protocol: text(m.protocol), completion: text(m.completion), firstTokenMs: number(m.firstTokenMs),
        attempts: number(m.attempts), retries: number(m.retries), reconstructed: m.reconstructed === true,
        enabled: typeof m.enabled === 'boolean' ? m.enabled : undefined,
        changes: numeric(m.changes, ['toolDescriptions', 'oldToolResults']),
        before: numeric(m.before, ['requestBytes', 'toolCount', 'toolBytes', 'textChars', 'toolResultChars', 'images']),
        after: numeric(m.after, ['requestBytes', 'toolCount', 'toolBytes', 'textChars', 'toolResultChars', 'images']),
        failover: (m.failover || []).slice(0, 10).map(v => ({ provider: text(v.provider), kind: text(v.kind) })),
        usage: usage ? Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens'].map(k => [k, number(usage[k])])) : null } };
  }
  prune() {
    const cutoff = Date.now() - this.days * 86400000;
    this.rows = this.rows.filter(r => Date.parse(r.time) >= cutoff).slice(0, this.maxEntries);
    let bytes = 0;
    this.rows = this.rows.filter(row => { bytes += Buffer.byteLength(JSON.stringify(row)) + 1; return bytes <= this.maxBytes; });
  }
  add(row) {
    this.rows.unshift(this.clean(row)); this.prune();
    // Coalesce bursts; one writer and atomic rename prevent partial histories.
    if (this.scheduled) return;
    this.scheduled = true;
    this.pending = this.pending.then(async () => {
      this.scheduled = false;
      const content = this.rows.map(r => JSON.stringify(r)).join('\n') + '\n';
      await fs.promises.writeFile(this.file + '.tmp', content, { mode: 0o600 });
      await fs.promises.rename(this.file + '.tmp', this.file); this.error = null;
    }).catch(() => { this.error = 'Request history could not be saved'; this.scheduled = false; });
  }
  async flush() { while (true) { const pending = this.pending; await pending; if (pending === this.pending) break; } }
  stats(hours = 24) {
    this.prune();
    const rows = this.rows.filter(r => Date.parse(r.time) >= Date.now() - hours * 3600000);
    const times = rows.map(r => r.tokenMetrics.firstTokenMs).filter(Number.isFinite).sort((a, b) => a - b);
    const known = rows.filter(r => r.tokenMetrics.usage);
    return { hours, requests: rows.length, succeeded: rows.filter(r => r.status === 200 && r.tokenMetrics.completion === 'completed').length,
      cancelled: rows.filter(r => r.tokenMetrics.completion === 'cancelled').length, usageKnown: known.length,
      inputTokens: known.reduce((n, r) => n + (r.tokenMetrics.usage.inputTokens || 0), 0),
      outputTokens: known.reduce((n, r) => n + (r.tokenMetrics.usage.outputTokens || 0), 0),
      cachedInputTokens: known.reduce((n, r) => n + (r.tokenMetrics.usage.cachedInputTokens || 0), 0),
      firstTokenP50: times.length ? times[Math.floor((times.length - 1) * .5)] : null,
      firstTokenP95: times.length ? times[Math.ceil((times.length - 1) * .95)] : null };
  }
}
