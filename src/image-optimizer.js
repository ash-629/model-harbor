// Optional image normalization for large multimodal requests. Data-URL images
// are downscaled/recompressed before they leave the gateway; remote URLs are
// left untouched so no server-side fetching or SSRF surface is introduced.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_SCRIPT = fileURLToPath(new URL('./image-compress.py', import.meta.url));
const DATA_URL = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/i;
const CACHE_LIMIT = 32;
const cache = new Map();
let warned = false;

function intEnv(env, name, fallback, min, max) {
  const value = Number.parseInt(env[name], 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function imageOptimizationSettings(env = process.env) {
  const requested = String(env.MH_IMAGE_OPTIMIZATION || 'opencode').toLowerCase();
  const mode = ['off', 'opencode', 'all'].includes(requested) ? requested : 'opencode';
  return {
    mode,
    maxDimension: intEnv(env, 'MH_IMAGE_MAX_DIMENSION', 1600, 256, 4096),
    quality: intEnv(env, 'MH_IMAGE_QUALITY', 80, 30, 95),
    minBytes: intEnv(env, 'MH_IMAGE_MIN_BYTES', 350000, 0, 20 * 1024 * 1024),
    maxInputBytes: intEnv(env, 'MH_IMAGE_MAX_INPUT_BYTES', 12 * 1024 * 1024, 256 * 1024, 40 * 1024 * 1024),
    timeoutMs: intEnv(env, 'MH_IMAGE_TIMEOUT_MS', 15000, 1000, 120000),
    cacheLimit: intEnv(env, 'MH_IMAGE_CACHE_LIMIT', CACHE_LIMIT, 0, 256),
  };
}

export function shouldOptimizeProviderImages(provider, settings, isOpenCode = false) {
  if (settings.mode === 'off') return false;
  if (settings.mode === 'all') return true;
  return Boolean(isOpenCode);
}

function collectTargets(payload) {
  const targets = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (typeof node.image_url === 'string') { targets.push({ holder: node, key: 'image_url', url: node.image_url }); return; }
    if (node.image_url && typeof node.image_url === 'object' && typeof node.image_url.url === 'string') {
      targets.push({ holder: node.image_url, key: 'url', url: node.image_url.url });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      // Tool definitions can contain example URLs; never rewrite schemas.
      if (key !== 'tools') visit(value);
    }
  };
  if (Array.isArray(payload.messages)) for (const message of payload.messages) visit(message);
  if (Array.isArray(payload.input)) for (const item of payload.input) visit(item);
  return targets.filter(target => DATA_URL.test(target.url));
}

function runPython(raw, options) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [options.scriptPath || DEFAULT_SCRIPT, String(options.maxDimension), String(options.quality), String(options.minBytes)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [], errors = [];
    let outputBytes = 0, errorBytes = 0, settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`image compression timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
    };
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxInputBytes * 2) {
        child.kill('SIGKILL');
        finish(new Error('compressed image unexpectedly large'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (errorBytes >= 20000) return;
      errorBytes += chunk.length;
      errors.push(chunk);
    });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      const stderr = Buffer.concat(errors).toString('utf8');
      if (code !== 0) {
        const message = stderr.split('\n').find(line => line.startsWith('MH_IMAGE_ERROR ')) || stderr.trim().slice(-300) || `python exited with ${code}`;
        return reject(new Error(message));
      }
      const metaLine = stderr.split('\n').find(line => line.startsWith('MH_IMAGE_META '));
      let meta = {};
      if (metaLine) { try { meta = JSON.parse(metaLine.slice('MH_IMAGE_META '.length)); } catch {} }
      resolve({ buffer: Buffer.concat(chunks), mime: meta.format === 'PNG' ? 'image/png' : 'image/jpeg', changed: Boolean(meta.changed), meta });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(raw);
  });
}

async function compress(raw, options, stats) {
  const key = crypto.createHash('sha256').update(raw).digest('hex') + ':' + [options.maxDimension, options.quality, options.minBytes].join(':');
  if (options.cacheLimit > 0 && cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    stats.cached++;
    return hit;
  }
  const result = await (options.compressor || runPython)(raw, options);
  if (options.cacheLimit > 0 && result.changed) {
    cache.set(key, result);
    while (cache.size > options.cacheLimit) cache.delete(cache.keys().next().value);
  }
  return result;
}

export async function optimizePayloadImages(payload, options = {}) {
  const stats = { images: 0, changed: 0, skipped: 0, failed: 0, cached: 0, originalBytes: 0, optimizedBytes: 0 };
  if (!options.enabled) return { payload, stats };
  if (!collectTargets(payload).length) return { payload, stats };

  const copy = structuredClone(payload);
  const targets = collectTargets(copy);
  if (!targets.length) return { payload, stats };

  for (const target of targets) {
    const match = DATA_URL.exec(target.url);
    if (!match) continue;
    stats.images++;
    const raw = Buffer.from(match[2], 'base64');
    stats.originalBytes += raw.length;
    if (raw.length > options.maxInputBytes) {
      stats.skipped++;
      stats.optimizedBytes += raw.length;
      continue;
    }
    try {
      const result = await compress(raw, options, stats);
      if (!result.changed) {
        stats.skipped++;
        stats.optimizedBytes += raw.length;
        continue;
      }
      const mime = result.mime || 'image/jpeg';
      target.holder[target.key] = `data:${mime};base64,${result.buffer.toString('base64')}`;
      stats.changed++;
      stats.optimizedBytes += result.buffer.length;
    } catch (error) {
      stats.failed++;
      stats.optimizedBytes += raw.length;
      if (!warned) {
        warned = true;
        console.warn(`[image-optimizer] compression unavailable: ${String(error?.message || error).slice(0, 240)}`);
      }
    }
  }
  return { payload: copy, stats };
}