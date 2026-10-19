// Explicit opt-in live benchmark. Not included by node --test test/*.test.js.
// Mount existing gateway data read-only; never print configuration or credentials.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Store } from '../../src/store.js';
import { route } from '../../src/upstream.js';
const dir = process.env.MH_BENCH_DATA;
if (!dir || process.env.MH_LIVE_BENCH !== '1') throw new Error('Explicit MH_LIVE_BENCH=1 and MH_BENCH_DATA are required');
const data = JSON.parse(fs.readFileSync(dir + '/config.json', 'utf8'));
const key = fs.readFileSync(dir + '/master.key');
const store = { unseal: value => Store.prototype.unseal.call({ key }, value) };
const provider = data.providers.find(p => p.id === (process.env.MH_BENCH_PROVIDER || 'deepseek') && p.type === 'openai');
if (!provider?.enabled) throw new Error('Benchmark provider unavailable');
const model = process.env.MH_BENCH_MODEL || 'deepseek-flash';
assert.ok(provider.models.includes(model));
const tools = Array.from({ length: 6 }, (_, i) => ({ type: 'function', function: {
  name: i === 0 ? 'verify_probe' : 'archive_' + i,
  description: (i === 0 ? 'Verify a benchmark marker. ' : 'Read an archived benchmark record. ') + 'This tool accepts a marker and returns it unchanged. '.repeat(100),
  parameters: { type: 'object', properties: { marker: { type: 'string', enum: ['BENCH_OK'] } }, required: ['marker'], additionalProperties: false }
} }));
const history = [
  { role: 'system', content: 'For this benchmark, call verify_probe with marker BENCH_OK when requested. After its result, reply exactly BENCH_OK. Archived results are irrelevant.' },
  { role: 'user', content: 'Read an old archive.' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'old_probe', type: 'function', function: { name: 'archive_1', arguments: '{"marker":"BENCH_OK"}' } }] },
  { role: 'tool', tool_call_id: 'old_probe', content: 'ARCHIVE_START\n' + 'Archived diagnostic row: inactive record, no current action.\n'.repeat(1400) + 'ARCHIVE_END' },
  { role: 'user', content: 'The archive is no longer relevant.' },
  { role: 'assistant', content: 'Acknowledged.' },
  { role: 'user', content: 'Prepare the current verification.' },
  { role: 'assistant', content: 'Ready.' },
  { role: 'user', content: 'Call verify_probe with marker BENCH_OK now.' }
];
const results = [];
for (const enabled of [false, true]) {
  const p = { ...provider, tokenOptimization: { enabled } }, calls = [];
  const body = { model, messages: structuredClone(history), tools, temperature: 0, max_tokens: 128,
    ...(provider.id === 'deepseek' ? { thinking: { type: 'disabled' } } : {}), tool_choice: { type: 'function', function: { name: 'verify_probe' } } };
  const invoke = async b => {
    const res = {};
    const result = await route(store, p, model, b, 'chat/completions', res);
    calls.push(res.apiMetrics);
    return result;
  };
  const first = await invoke(body), message = first.choices?.[0]?.message;
  const call = message?.tool_calls?.[0];
  assert.equal(call?.function.name, 'verify_probe');
  assert.equal(JSON.parse(call.function.arguments).marker, 'BENCH_OK');
  const final = await invoke({ ...body, tool_choice: 'none', messages: [...body.messages, message,
    { role: 'tool', tool_call_id: call.id, content: 'BENCH_OK' }] });
  assert.equal(final.choices?.[0]?.message?.content?.trim(), 'BENCH_OK');
  const totalInput = calls.reduce((n,c) => n + c.usage.inputTokens, 0);
  const report = { enabled, calls, totalInputTokens: totalInput, totalOutputTokens: calls.reduce((n,c) => n + c.usage.outputTokens, 0),
    totalCachedInputTokens: calls.reduce((n,c) => n + (c.usage.cachedInputTokens || 0), 0), toolAndFinalVerified: true };
  results.push(report);
  console.log(JSON.stringify({ stage: enabled ? 'optimized' : 'baseline', totalInputTokens: totalInput, totalCachedInputTokens: report.totalCachedInputTokens, toolAndFinalVerified: true }));
}
const report = { provider: provider.id, model, kind: 'synthetic-two-call-task', timestamp: new Date().toISOString(), results,
  inputReduction: 1 - results[1].totalInputTokens / results[0].totalInputTokens };
if (process.env.MH_BENCH_REPORT) fs.writeFileSync(process.env.MH_BENCH_REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ inputReduction: report.inputReduction, note: 'Not a production average or cost reduction; cache differs between calls.' }));
