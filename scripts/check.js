import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dirs = ['src', 'public', 'scripts', 'test'];
let count = 0;
for (const dir of dirs) for (const filename of readdirSync(dir)) {
  if (!filename.endsWith('.js')) continue;
  const result = spawnSync(process.execPath, ['--check', join(dir, filename)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
  count++;
}
JSON.parse(readFileSync('package.json', 'utf8'));
console.log(`Syntax checked ${count} JavaScript files; package metadata is valid.`);
