import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { VideoProviders } from '../src/video-providers.js';
import { VideoJobs } from '../src/videos.js';
import { grokVideoCommand, videoInfo } from '../src/grok-video.js';

const mp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=', 'base64');
const provider = { id: 'grok-video', name: 'Grok Video', type: 'grok', execution: 'ssh-docker', sshHost: '192.0.2.10', sshUser: 'example-user', sshKeyPath: '/keys/key', runnerPath: '/workspace/model-harbor/grok-video-runner.py', container: 'claude-linux', dockerPath: '/usr/local/bin/docker', grokPath: '/home/dev/.local/bin/grok', model: 'grok-4.7', timeout: 30 };
const wait = async fn => { for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 5)); } throw new Error('timeout'); };

test('Grok video provider, runner command and media validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-video-provider-'));
  try {
    const store = new Store(dir), providers = new VideoProviders(store);
    providers.upsert(provider);
    const configured = providers.get('grok-video');
    assert.equal(configured.model, 'grok-4.7');
    const command = grokVideoCommand(configured, 'generate', '12345678-1234-1234-1234-123456789012');
    assert.equal(command.command, 'ssh');
    assert.match(command.args.at(-1), /'python3' '\/workspace\/model-harbor\/grok-video-runner.py' 'generate'/);
    assert.equal(videoInfo(mp4).mime, 'video/mp4');
    assert.throws(() => providers.upsert({ ...provider, id: 'bad', type: 'codex' }), /Unknown video provider/);
    assert.throws(() => providers.upsert({ ...provider, id: 'bad', grokPath: '/bin/sh' }), /Grok path/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('video jobs accept three references, persist completed media and reject invalid settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-video-jobs-'));
  try {
    const store = new Store(dir), providers = new VideoProviders(store); providers.upsert(provider);
    const reference = 'data:image/png;base64,' + png.toString('base64');
    let calls = 0;
    const jobs = new VideoJobs(store, providers, dir, { execute: async (p, job) => { calls++; assert.equal(job.referenceCount, 3); return { bytes: mp4, ext: 'mp4' }; } });
    const created = jobs.create({ providerId: 'grok-video', prompt: 'a paper boat on a pond', aspect: '16:9', duration: 6, resolution: '480p', references: [reference, reference, reference] });
    assert.equal(created.status, 'queued');
    const done = await wait(() => jobs.get(created.id).status === 'completed' && jobs.get(created.id));
    assert.equal(done.mime, 'video/mp4'); assert.equal(done.referenceCount, 3); assert.equal(calls, 1);
    assert.equal(jobs.file(done.id).job.ext, 'mp4');
    assert.throws(() => jobs.create({ providerId: 'grok-video', prompt: 'x', duration: 7 }), /duration/);
    assert.throws(() => jobs.create({ providerId: 'grok-video', prompt: 'x', references: [reference, reference, reference, reference] }), /3/);
    jobs.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
