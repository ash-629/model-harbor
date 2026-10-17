import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { agentCommand, agentTail } from '../src/nas-agent.js';
import { modelCommand, cacheScript, hostCacheScript } from '../src/remote-codex.js';

const provider = { id: 'remote', type: 'nas-codex', sshHost: 'host', sshUser: 'ubuntu', sshKeyPath: '/keys/key', container: 'codex-linux', models: ['model'] };
test('SSH execution persists without a container; legacy Docker stays compatible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-ssh-'));
  try {
    const store = new Store(dir);
    const legacy = store.upsert(provider);
    assert.equal(legacy.execution, 'ssh-docker');
    assert.equal(legacy.container, 'codex-linux');
    const ssh = store.upsert({ ...provider, execution: 'ssh', container: '', codexPath: '/home/ubuntu/.local/bin/codex' }, 'remote');
    assert.equal(ssh.execution, 'ssh'); assert.equal(ssh.container, undefined);
    assert.equal(new Store(dir).get('remote').codexPath, ssh.codexPath);
    assert.equal(store.upsert({ ...provider, container: undefined }, 'remote').execution, 'ssh');
    assert.throws(() => store.upsert({ ...provider, execution: 'local' }, 'remote'), /SSH/);
    assert.throws(() => store.upsert({ ...provider, execution: 'ssh-docker', container: '' }, 'remote'), /container/);
    assert.throws(() => store.upsert({ ...provider, execution: 'ssh', codexPath: 'codex; touch /tmp/bad' }, 'remote'), /Codex/);
    assert.equal(store.resolve('remote/model').model, 'model');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SSH launch bypasses Docker for native app-server and host model discovery', () => {
  const ssh = { ...provider, execution: 'ssh', codexPath: '/opt/codex bin/codex' };
  const command = agentCommand(ssh);
  assert.equal(command.command, 'ssh');
  assert.equal(command.args.at(-1).includes('docker'), false);
  assert.match(command.args.at(-1), /'\/opt\/codex bin\/codex' 'app-server'/);
  assert.match(command.args.at(-1), /'features.shell_tool=false'/);
  assert.deepEqual(modelCommand(ssh), ['python3', '-c', hostCacheScript]);
  assert.match(hostCacheScript, /CODEX_HOME/);
  const expected = ['sudo', '-n', '/usr/local/bin/docker', 'exec', '-i', 'codex-linux'];
  const quoted = args => args.map(s => "'" + s + "'").join(' ');
  assert.equal(agentCommand(provider).args.at(-1), quoted([...expected, ...agentTail]));
  assert.deepEqual(modelCommand(provider), [...expected, 'python3', '-c', cacheScript]);
});
