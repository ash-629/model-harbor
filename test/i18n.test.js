import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { messages, setLanguage, getLanguage, t, translateError } from '../public/i18n.js';

test('translations cover the static Chinese UI and translated dynamic messages', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = ['app.js', 'image-ui.js'].map(file => fs.readFileSync(new URL('../public/' + file, import.meta.url), 'utf8')).join('\n');
  const chinese = /[\u4e00-\u9fff]/;
  const strings = [
    ...[...html.matchAll(/>([^<>]+)</g)].map(m => m[1].trim()),
    ...[...html.matchAll(/(?:placeholder|aria-label)="([^"]+)"/g)].map(m => m[1]),
    ...[...script.matchAll(/\bt\('([^']+)'/g)].map(m => m[1]),
  ].filter(s => chinese.test(s));
  assert.deepEqual(strings.filter(s => !messages[s]), []);
  for (const [key, value] of Object.entries(messages)) {
    assert.equal(chinese.test(value), false, key);
    assert.deepEqual([...key.matchAll(/\{\w+\}/g)].map(m => m[0]).sort(), [...value.matchAll(/\{\w+\}/g)].map(m => m[0]).sort(), key);
  }
});

test('language switching, persistence, placeholders and dynamic errors', async () => {
  const memory = new Map();
  globalThis.localStorage = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v) };
  try {
    setLanguage('en');
    assert.equal(getLanguage(), 'en');
    assert.equal(memory.get('model-harbor-language'), 'en');
    const fresh = await import('../public/i18n.js?persisted');
    assert.equal(fresh.getLanguage(), 'en');
    assert.equal(t('共 {count} 个模型 · 仅显示已启用供应商的配置模型', { count: 9 }), '9 models · Only enabled providers are listed');
    assert.equal(t('nas/gpt-6.1-sol'), 'nas/gpt-6.1-sol');
    assert.equal(translateError('上游 My Provider 返回 HTTP 429；请检查密钥、模型权限和接口协议'), 'Upstream My Provider returned HTTP 429. Check its key, model access and protocol.');
    assert.equal(translateError('SSH 认证失败（退出码 255）'), 'SSH authentication failed (exit code 255)');
    setLanguage('zh-CN');
    assert.equal(t('供应商'), '供应商');
    assert.equal(t('{count} 个模型', { count: 7 }), '7 个模型');
    globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.doesNotThrow(() => setLanguage('en'));
  } finally { delete globalThis.localStorage; setLanguage('zh-CN'); }
});
