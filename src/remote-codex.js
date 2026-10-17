// Shared remote runtime selection. Missing execution preserves existing Docker providers.
export const runtimePrefix = p => p.execution === 'ssh' ? [] : ['sudo', '-n', '/usr/local/bin/docker', 'exec', '-i', p.container];
export const codexExecutable = p => p.execution === 'ssh' ? (p.codexPath || 'codex') : 'codex';
export const cacheScript = 'import json; d=json.load(open("/home/dev/.codex/models_cache.json")); print(json.dumps([m["slug"] for m in d.get("models",[]) if m.get("slug") and m.get("visibility","list")=="list"]))';
export const hostCacheScript = 'import json,os; d=json.load(open(os.path.join(os.path.expanduser(os.environ.get("CODEX_HOME","~/.codex")),"models_cache.json"))); print(json.dumps([m["slug"] for m in d.get("models",[]) if m.get("slug") and m.get("visibility","list")=="list"]))';
export const modelCommand = p => [...runtimePrefix(p), 'python3', '-c', p.execution === 'ssh' ? hostCacheScript : cacheScript];
