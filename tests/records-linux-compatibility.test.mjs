import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('Linux package dependencies resolve on the supported Ubuntu 22.04 baseline',async()=>{
  const config=JSON.parse(await readFile(new URL('../apps/desktop/src-tauri/tauri.linux.conf.json',import.meta.url),'utf8'));
  const deps=config.bundle.linux.deb.depends;
  assert.ok(deps.some(d=>/^libasound2(?:\s|$)/.test(d)),'Ubuntu 22.04 requires libasound2 rather than a mandatory t64-only package');
  assert.ok(!deps.includes('libasound2t64'));
  const workflow=await readFile(new URL('../.github/workflows/preview-release.yml',import.meta.url),'utf8');
  assert.match(workflow,/build_wgs:[\s\S]*?runs-on: \[self-hosted, Linux, X64, lingji-wgs\]/);
  const script=await readFile(new URL('../scripts/release-linux-preview.mjs',import.meta.url),'utf8');
  assert.ok(script.includes('22\\.04'),'WGS package gate still requires Ubuntu 22.04');
});

test('Ubuntu 22 uses the PulseAudio protocol rather than a newer PipeWire ABI',async()=>{
  const cargo=await readFile(new URL('../apps/desktop/src-tauri/Cargo.toml',import.meta.url),'utf8');
  const linux=cargo.split("[target.'cfg(target_os = \"linux\")'.dependencies]")[1]?.split('[features]')[0];
  assert.ok(linux?.includes('features = ["pulseaudio"]'));
  assert.ok(!linux?.includes('features = ["pipewire"]'));
});
