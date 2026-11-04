import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { BUILTIN_VOCABULARY_MAX_BYTES, parseBuiltinVocabulary, readBuiltinVocabulary } from '../services/records/src/builtin-vocabulary.mjs';

// Two separately masked chunks keep each Windows environment value below 32,767 characters.
export async function materializeBuiltinVocabulary({ base = new URL('../services/records/src/data/', import.meta.url), encoded = (process.env.TTS_BUILTIN_VOCABULARY_GZIP_BASE64_PART1 || '') + (process.env.TTS_BUILTIN_VOCABULARY_GZIP_BASE64_PART2 || '') } = {}) {
  const manifest = JSON.parse(await readFile(new URL('builtin-vocabulary.manifest.json', base), 'utf8'));
  if (encoded) {
    if (encoded.length > 200_000 || !/^[A-Za-z0-9+/=\s]+$/.test(encoded)) throw new Error('invalid_builtin_vocabulary_input');
    const bytes = gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: BUILTIN_VOCABULARY_MAX_BYTES });
    parseBuiltinVocabulary(bytes, manifest);
    await writeFile(new URL('builtin-vocabulary.private.json', base), bytes, { mode: 0o600 });
  }
  const pack = await readBuiltinVocabulary(base);
  if (!pack.available) throw new Error(`builtin_vocabulary_required:${pack.reason}`);
  return { version: pack.version, entries: pack.entries.length, sha256: pack.hash };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await materializeBuiltinVocabulary()));
