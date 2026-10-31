"""Build the pinned Mandarin reading subset; never reads meeting or account data."""
import hashlib
import json
import re
import sys
import unicodedata
import zipfile
from pathlib import Path

ARCHIVE_SHA256 = '4c93ea9c1f636451729a840978f1667a53886af37ba854fdcce109721c63d43e'
root = Path(__file__).resolve().parent.parent
archive = Path(sys.argv[1])
assert hashlib.sha256(archive.read_bytes()).hexdigest() == ARCHIVE_SHA256, 'Unexpected Unicode archive'
readings = {}
with zipfile.ZipFile(archive) as source:
    for line in source.read('Unihan_Readings.txt').decode('utf-8').splitlines():
        if not line or line.startswith('#'):
            continue
        code, field, value = line.split('\t')
        if field not in ('kMandarin', 'kHanyuPinyin'):
            continue
        char = chr(int(code[2:], 16))
        if not 0x3400 <= ord(char) <= 0x9FFF:
            continue
        values = value.split() if field == 'kMandarin' else [word for part in value.split() for word in part.split(':', 1)[-1].split(',')]
        for word in values:
            normalized = ''.join(c for c in unicodedata.normalize('NFD', word.replace('ü', 'v').replace('ǖ', 'v').replace('ǘ', 'v').replace('ǚ', 'v').replace('ǜ', 'v')) if not unicodedata.combining(c)).lower()
            if re.fullmatch('[a-zv]{1,8}', normalized):
                readings.setdefault(char, set()).add(normalized)
    original = {char: set(words) for char, words in readings.items()}
    for line in source.read('Unihan_Variants.txt').decode('utf-8').splitlines():
        if not line or line.startswith('#'):
            continue
        code, field, value = line.split('\t')
        char = chr(int(code[2:], 16))
        if field != 'kTraditionalVariant' or not 0x3400 <= ord(char) <= 0x9FFF:
            continue
        for variant in value.split():
            target = chr(int(variant.split('<')[0][2:], 16))
            readings.setdefault(char, set()).update(original.get(target, set()))
output = root / 'packages/records/src/data'
output.mkdir(exist_ok=True)
content = (json.dumps({'version': '18.0.0', 'language': 'zh', 'readings': {char: sorted(words) for char, words in sorted(readings.items()) if words}}, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
assert 'xiao' in readings['晓'] and 'xiao' in readings['小'] and 'xie' in readings['解'] and 'shan' in readings['单']
(output / 'mandarin-readings.json').write_bytes(content)
manifest = {'id': 'lingji-mandarin-readings', 'version': '18.0.0', 'schema': 1, 'languages': ['zh'], 'source': 'https://www.unicode.org/Public/18.0.0/ucd/Unihan.zip', 'sourceSha256': ARCHIVE_SHA256, 'properties': ['kMandarin', 'kHanyuPinyin', 'kTraditionalVariant'], 'range': 'U+3400..U+9FFF', 'characters': len(json.loads(content)['readings']), 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest(), 'license': 'Unicode-3.0', 'notice': 'UNICODE-LICENSE.txt'}
(output / 'mandarin-readings.manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'characters': len(json.loads(content)['readings']), 'bytes': len(content), 'sha256': manifest['sha256']}))
