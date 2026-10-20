import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolDownloads, compareVersions } from '../src/tools.js';

test('tool version comparison is numeric and tolerant of dotted builds', () => {
  assert.equal(compareVersions('26.1013.4894.0', '26.1013.4893.0'), 1);
  assert.equal(compareVersions('26.9.0', '26.10.0'), -1);
  assert.equal(compareVersions('26.1013', '26.1013.0'), 0);
});

test('tool catalog discovers the newest cached package, cleans partial files and hides paths', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'tools', 'chatgpt');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'chatgpt-desktop-26.1013.4893.0-x64.msix'), 'old');
  fs.writeFileSync(path.join(root, 'chatgpt-desktop-26.1013.4894.0-x64.msix'), 'new-package');
  fs.writeFileSync(path.join(root, 'chatgpt-desktop-26.1013.4895.0-x64.msix.part'), 'partial');
  const tools = new ToolDownloads(dir, { env: { MH_TOOL_PROXY: 'http://proxy.invalid:7890' } });
  const tool = tools.publicTool();
  assert.equal(tool.installedVersion, '26.1013.4894.0');
  assert.equal(tool.bytes, 11);
  assert.equal(tool.proxyConfigured, true);
  assert.equal(tool.downloadUrl, '/api/tools/chatgpt/download');
  assert.equal(JSON.stringify(tool).includes(root), false);
  assert.equal(fs.existsSync(path.join(root, 'chatgpt-desktop-26.1013.4895.0-x64.msix.part')), false);
  const file = tools.file();
  assert.equal(path.basename(file.file), 'chatgpt-desktop-26.1013.4894.0-x64.msix');
});
