import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, HttpError } from '../src/store.js';
import { isQuotaError, routeWithFailover } from '../src/upstream.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-harbor-group-'));
  return { store: new Store(dir), dir };
}
function addCodex(store, id, models = ['gpt-6.1-sol']) {
  return store.upsert({ id, name: id, type: 'nas-codex', models, execution: 'ssh-docker', sshHost: '192.168.2.37', sshUser: 'neko629', container: 'codex-' + id, sshPort: 22, sshKeyPath: '/home/node/.ssh/id_ed25519', codexPath: 'codex', dockerPath: '/usr/local/bin/docker' });
}
function response(provider, model) {
  return { id: 'resp_' + provider, created_at: 1, model, output: [{ type: 'message', id: 'msg_' + provider, content: [{ type: 'output_text', text: 'from ' + provider }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
}
function fakeAgent(behaviour) {
  return {
    run: async (p, model) => behaviour[p.id](p, model),
    usage: async () => ({ buckets: [{ windows: [] }] })
  };
}

test('group merges models, hides members and keeps direct routes working', () => {
  const { store, dir } = tempStore();
  addCodex(store, 'nas');
  addCodex(store, 'nas2', ['gpt-6.1-sol', 'gpt-6-luna']);
  store.upsertGroup({ id: 'codex', name: 'Codex 组', members: ['nas', 'nas2'] });

  const ids = store.models().map(m => m.id);
  assert.ok(ids.includes('codex/gpt-6.1-sol'));
  assert.ok(ids.includes('codex/gpt-6-luna'));
  assert.equal(ids.filter(id => id.startsWith('codex/')).length, 2);
  assert.ok(!ids.includes('nas/gpt-6.1-sol'));
  assert.ok(!ids.includes('nas2/gpt-6.1-sol'));

  const resolved = store.resolve('codex/gpt-6.1-sol');
  assert.equal(resolved.group.id, 'codex');
  assert.deepEqual(resolved.candidates.map(c => c.provider.id), ['nas', 'nas2']);

  const direct = store.resolve('nas/gpt-6.1-sol');
  assert.equal(direct.provider.id, 'nas');
  assert.equal(direct.group, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('group validation rejects non-codex members and duplicate prefixes', () => {
  const { store, dir } = tempStore();
  addCodex(store, 'nas');
  store.upsert({ id: 'deepseek', name: 'deepseek', type: 'openai', models: ['deepseek-flash'], baseUrl: 'https://api.deepseek.com' });
  assert.throws(() => store.upsertGroup({ id: 'mix', name: 'mix', members: ['nas', 'deepseek'] }), /不是 Codex 供应商/);
  assert.throws(() => store.upsertGroup({ id: 'nas', name: 'dup', members: ['nas'] }), /前缀/);
  assert.throws(() => store.upsertGroup({ id: 'empty', name: 'empty', members: [] }), /1–10/);
  store.upsertGroup({ id: 'codex', name: 'Codex', members: ['nas'] });
  assert.throws(() => store.upsertGroup({ id: 'codex', name: 'Codex', members: ['nas'] }), /已存在/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('failover switches to the next account and records a cooldown', async () => {
  const { store, dir } = tempStore();
  addCodex(store, 'nas');
  addCodex(store, 'nas2');
  store.upsertGroup({ id: 'codex', name: 'Codex 组', members: ['nas', 'nas2'] });
  const calls = [];
  const agent = fakeAgent({
    nas: () => { calls.push('nas'); throw new HttpError(502, "远程 Codex 工具桥接失败：You've hit your usage limit. Upgrade to Pro or try again later."); },
    nas2: (p, model) => { calls.push('nas2'); return response('nas2', model); }
  });
  const body = { model: 'codex/gpt-6.1-sol', messages: [{ role: 'user', content: 'hi' }] };
  const resolved = store.resolve(body.model);
  const output = await routeWithFailover(store, resolved, body, 'chat/completions', {}, undefined, agent);
  assert.equal(output.choices[0].message.content, 'from nas2');
  assert.deepEqual(calls, ['nas', 'nas2']);
  assert.ok(store.groupCooldown('codex', 'nas'));

  calls.length = 0;
  const second = await routeWithFailover(store, store.resolve(body.model), body, 'chat/completions', {}, undefined, agent);
  assert.equal(second.choices[0].message.content, 'from nas2');
  assert.deepEqual(calls, ['nas2']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('non-quota errors are not retried and all-cooling groups report exhaustion', async () => {
  const { store, dir } = tempStore();
  addCodex(store, 'nas');
  addCodex(store, 'nas2');
  store.upsertGroup({ id: 'codex', name: 'Codex 组', members: ['nas', 'nas2'] });
  const calls = [];
  const failing = fakeAgent({
    nas: () => { calls.push('nas'); throw new HttpError(502, 'connection refused'); },
    nas2: () => { calls.push('nas2'); return response('nas2', 'gpt-6.1-sol'); }
  });
  await assert.rejects(routeWithFailover(store, store.resolve('codex/gpt-6.1-sol'), { model: 'codex/gpt-6.1-sol', messages: [] }, 'chat/completions', {}, undefined, failing), /connection refused/);
  assert.deepEqual(calls, ['nas']);
  assert.equal(store.groupCooldown('codex', 'nas'), null);

  const exhausted = fakeAgent({
    nas: () => { throw new HttpError(502, 'insufficient_quota'); },
    nas2: () => { throw new HttpError(502, 'usage limit reached'); }
  });
  await assert.rejects(routeWithFailover(store, store.resolve('codex/gpt-6.1-sol'), { model: 'codex/gpt-6.1-sol', messages: [] }, 'chat/completions', {}, undefined, exhausted), /usage limit|额度/i);
  assert.ok(store.groupCooldown('codex', 'nas'));
  assert.ok(store.groupCooldown('codex', 'nas2'));
  await assert.rejects(routeWithFailover(store, store.resolve('codex/gpt-6.1-sol'), { model: 'codex/gpt-6.1-sol', messages: [] }, 'chat/completions', {}, undefined, exhausted), /额度暂不可用/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('quota classifier distinguishes quota and rate limits', () => {
  assert.equal(isQuotaError(new HttpError(502, "You've hit your usage limit")), true);
  assert.equal(isQuotaError(new HttpError(502, 'insufficient_quota')), true);
  assert.equal(isQuotaError(new HttpError(429, 'Too many requests')), true);
  assert.equal(isQuotaError(new HttpError(502, 'connection refused')), false);
});