import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}
const files = [...await walk('docs'), 'README.md', 'AGENTS.md', 'CONTEXT.md', 'implementation_plan.md'].filter(file => file.endsWith('.md'));
const errors = [];
for (const file of files) {
  const text = await readFile(file, 'utf8'); let fence = '';
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(```|~~~)/); if (match) { if (!fence) fence = match[1]; else if (fence === match[1]) fence = ''; }
  }
  if (fence) errors.push(`${file}: unclosed fence`);
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^(?:https?:|mailto:|app:|codex:)/.test(target)) continue;
    try { await access(resolve(dirname(file), decodeURIComponent(target))); }
    catch { errors.push(`${file}: missing ${target}`); }
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Validated ${files.length} Markdown files: local references and fences.`);
