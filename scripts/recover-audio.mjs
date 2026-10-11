import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { digest, requireThat } from '../packages/records/src/record.mjs';
import { waveHeader } from '../services/records/src/providers.mjs';
const [input, output] = process.argv.slice(2);
requireThat(input && output, 'Usage: node scripts/recover-audio.mjs <pending-audio.json> <output-directory>', 400);
const archive = JSON.parse(await readFile(resolve(input), 'utf8'));
requireThat(archive.format === 'meeting-audio-backup/v1' && Array.isArray(archive.chunks) && archive.chunks.length <= 10000, 'invalid_backup', 400);
const directory = resolve(output); await mkdir(directory, { recursive: true });
const chunks = archive.chunks.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.sequence - b.sequence);
let group = [], index = 0;
async function flush() {
  if (!group.length) return;
  const bytes = Buffer.concat(group.map(c => c.bytes));
  const file = join(directory, `recovered-${++index}-seq${group[0].sequence}-${group.at(-1).sequence}.wav`);
  await writeFile(file, Buffer.concat([waveHeader(bytes.length), bytes]), { flag: 'wx', mode: 0o600 }); group = [];
}
for (const chunk of chunks) {
  const bytes = Buffer.from(chunk.pcm, 'base64'); requireThat(digest(bytes) === chunk.digest && bytes.length === chunk.sampleCount * 2 && chunk.sampleRate === 16000, 'backup_checksum_failed', 400);
  const previous = group.at(-1);
  if (previous && (previous.sourceId !== chunk.sourceId || previous.sequence + 1 !== chunk.sequence || previous.epoch !== chunk.epoch || group.length >= 100)) await flush();
  group.push({ ...chunk, bytes });
}
await flush(); console.log(`Recovered ${index} WAV file(s). Gaps remain separate; re-import into a new record.`);
