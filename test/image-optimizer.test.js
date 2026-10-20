import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageOptimizationSettings, optimizePayloadImages, shouldOptimizeProviderImages } from '../src/image-optimizer.js';

const dataUrl = (text, mime = 'image/png') => `data:${mime};base64,${Buffer.from(text).toString('base64')}`;
const baseOptions = { enabled: true, maxDimension: 1600, quality: 80, minBytes: 0, maxInputBytes: 1024 * 1024, timeoutMs: 1000, cacheLimit: 0 };

test('downscales data-url images without mutating the original payload', async () => {
  const source = dataUrl('original-image');
  const payload = { model: 'ocgo/deepseek-v4.1-flash', messages: [{ role: 'user', content: [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: source, detail: 'high' } }
  ] }] };
  const seen = [];
  const result = await optimizePayloadImages(payload, { ...baseOptions, compressor: async raw => { seen.push(raw.toString()); return { changed: true, mime: 'image/jpeg', buffer: Buffer.from('small') }; } });
  assert.deepEqual(seen, ['original-image']);
  assert.equal(result.stats.images, 1);
  assert.equal(result.stats.changed, 1);
  assert.equal(result.stats.originalBytes, 14);
  assert.equal(result.stats.optimizedBytes, 5);
  assert.equal(payload.messages[0].content[1].image_url.url, source);
  assert.equal(result.payload.messages[0].content[1].image_url.url, `data:image/jpeg;base64,${Buffer.from('small').toString('base64')}`);
  assert.equal(result.payload.messages[0].content[1].image_url.detail, 'high');
});

test('leaves remote image URLs and payloads without data URLs untouched', async () => {
  const payload = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] };
  let calls = 0;
  const result = await optimizePayloadImages(payload, { ...baseOptions, compressor: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(result.payload, payload);
  assert.equal(result.stats.images, 0);
});

test('handles Responses input_image items and avoids tool schemas', async () => {
  const source = dataUrl('input-image');
  const payload = {
    input: [{ type: 'input_image', image_url: source, detail: 'auto' }],
    tools: [{ type: 'function', function: { parameters: { examples: [{ image_url: dataUrl('tool-example') }] } } }]
  };
  const result = await optimizePayloadImages(payload, { ...baseOptions, compressor: async () => ({ changed: true, mime: 'image/webp', buffer: Buffer.from('webp') }) });
  assert.equal(result.stats.images, 1);
  assert.match(result.payload.input[0].image_url, /^data:image\/webp;base64,/);
  assert.equal(payload.input[0].image_url, source);
  assert.match(payload.tools[0].function.parameters.examples[0].image_url, /^data:image\/png;base64,/);
});

test('keeps the original when the compressor reports no change', async () => {
  const source = dataUrl('already-small');
  const payload = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: source } }] }] };
  const result = await optimizePayloadImages(payload, { ...baseOptions, compressor: async () => ({ changed: false, buffer: Buffer.from('ignored') }) });
  assert.equal(result.stats.skipped, 1);
  assert.equal(result.payload.messages[0].content[0].image_url.url, source);
});

test('caches identical images within the configured limit', async () => {
  const payload = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl('cache-me') } }] }] };
  let calls = 0;
  const options = { ...baseOptions, cacheLimit: 4, compressor: async () => { calls++; return { changed: true, mime: 'image/jpeg', buffer: Buffer.from('cached') }; } };
  await optimizePayloadImages(payload, options);
  const second = await optimizePayloadImages(payload, options);
  assert.equal(calls, 1);
  assert.equal(second.stats.cached, 1);
});

test('reads and clamps environment settings', () => {
  const settings = imageOptimizationSettings({ MH_IMAGE_OPTIMIZATION: 'all', MH_IMAGE_MAX_DIMENSION: '9999', MH_IMAGE_QUALITY: '1', MH_IMAGE_MIN_BYTES: '-1' });
  assert.equal(settings.mode, 'all');
  assert.equal(settings.maxDimension, 4096);
  assert.equal(settings.quality, 30);
  assert.equal(settings.minBytes, 0);
  assert.equal(imageOptimizationSettings({ MH_IMAGE_OPTIMIZATION: 'nonsense' }).mode, 'opencode');
  assert.equal(shouldOptimizeProviderImages({}, { mode: 'opencode' }, true), true);
  assert.equal(shouldOptimizeProviderImages({}, { mode: 'opencode' }, false), false);
  assert.equal(shouldOptimizeProviderImages({}, { mode: 'off' }, true), false);
  assert.equal(shouldOptimizeProviderImages({}, { mode: 'all' }, false), true);
});