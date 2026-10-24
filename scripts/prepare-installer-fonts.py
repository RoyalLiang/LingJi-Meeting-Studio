"""Regenerate committed installer-only fonts with fonttools==4.60.1.
Usage: python prepare-installer-fonts.py /path/to/NotoSansSC.ttf
The original OFL font is pinned in installer/fonts/provenance.json.
"""
import hashlib
import json
import sys
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
root = Path(__file__).resolve().parent.parent
out = root / 'apps/desktop/src-tauri/installer/fonts'
source = Path(sys.argv[1])
provenance = json.loads((out / 'provenance.json').read_text())
assert hashlib.sha256(source.read_bytes()).hexdigest() == provenance['sourceSha256']
text = ''.join(chr(i) for i in range(32, 127)) + (out.parent / 'lingji-theme.nsh').read_text()
for weight, style in [(400, 'Regular'), (600, 'SemiBold')]:
    font = TTFont(source, recalcTimestamp=False)
    options = subset.Options()
    options.name_IDs = ['*']
    options.name_legacy = True
    options.name_languages = ['*']
    worker = subset.Subsetter(options=options)
    worker.populate(text=text)
    worker.subset(font)
    font = instantiateVariableFont(font, {'wght': weight}, inplace=True)
    font.recalcTimestamp = False
    font['head'].created = font['head'].modified = 2082844800
    names = {1: 'LingJi Installer Sans', 2: style, 3: 'LingJiInstallerSans-' + style + '-1.0',
             4: 'LingJi Installer Sans ' + style, 6: 'LingJiInstallerSans-' + style,
             16: 'LingJi Installer Sans', 17: style, 21: 'LingJi Installer Sans', 22: style}
    for record in font['name'].names:
        if record.nameID in names:
            record.string = names[record.nameID].encode(record.getEncoding())
    for key, value in names.items():
        font['name'].setName(value, key, 3, 1, 0x409)
    font['OS/2'].usWeightClass = weight
    path = out / ('lingji-ui-' + style.lower() + '.ttf')
    font.save(path)
    print(json.dumps({'font': path.name, 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}))
