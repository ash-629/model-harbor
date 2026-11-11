import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '__pycache__') walk(file);
    else if (entry.isFile() && /\.(?:js|mjs|py)$/.test(file)) files.push(file);
  }
}
for (const dir of ['src', 'public', 'test', 'examples', 'scripts']) if (fs.existsSync(dir)) walk(dir);
let failed = false;
for (const file of files) {
  const python = file.endsWith('.py');
  const result = spawnSync(python ? (process.platform === 'win32' ? 'python' : 'python3') : process.execPath,
    python ? ['-c', 'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8-sig"), filename=sys.argv[1])', file] : ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; console.error(file, result.error?.message || result.stderr || result.stdout); }
}
console.log(`Checked ${files.length} JavaScript/Python source files`);
process.exitCode = failed ? 1 : 0;
