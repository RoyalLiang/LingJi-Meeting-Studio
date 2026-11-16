import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertCurrentSource, finishCurrentBuild, verifyWgsInput} from '../scripts/wgs-build-contract.mjs';
import {releaseHash, snapshotReleaseSource} from '../scripts/release-source.mjs';
import {copyWindowsMsix, msixVersion, storeIdentity} from '../scripts/windows-msix.mjs';

const cargoPath = 'apps/desktop/src-tauri/Cargo.toml';
const cargo = '[package]\nname = "fixture"\nversion = "1.0.0"\n\n[dependencies]\ntauri = { version = "2", features = ["tray-icon"] }\n';

async function sourceFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lingji-wgs-source-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']}).toString().trim();
  git('init');
  const files = {'package.json': '{"name":"fixture"}', 'apps/web/src/main.ts': 'export const value = 1;\n', [cargoPath]: cargo};
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), content);
  }
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.test', 'commit', '-m', 'fixture');
  return {root, revision: git('rev-parse', 'HEAD')};
}

test('WGS current-directory guard accepts the exact committed source and rejects edited, deleted, or untracked source', async t => {
  const {root, revision} = await sourceFixture(t);
  const expected = await snapshotReleaseSource({root, ref: revision});
  assert.deepEqual(await assertCurrentSource(root, revision), expected);
  const entry = join(root, 'apps/web/src/main.ts');
  await writeFile(entry, 'export const value = 2;\n');
  await assert.rejects(assertCurrentSource(root, revision), {code: 'ERR_ASSERTION'});
  await writeFile(entry, 'export const value = 1;\n');
  const extra = join(root, 'apps/web/src/extra.ts');
  await writeFile(extra, 'export const uncommitted = true;\n');
  await assert.rejects(assertCurrentSource(root, revision), {code: 'ERR_ASSERTION'});
  await unlink(extra);
  await unlink(entry);
  await assert.rejects(assertCurrentSource(root, revision), {code: 'ERR_ASSERTION'});
});

test('WGS finish accepts an unchanged Cargo manifest or restores the known Tauri feature adjustment', async t => {
  const {root, revision} = await sourceFixture(t);
  const expected = await assertCurrentSource(root, revision);
  assert.deepEqual(await finishCurrentBuild(root, revision, cargo), expected);
  await writeFile(join(root, cargoPath), cargo.replace('features = ["tray-icon"]', 'features = ["macos-private-api", "tray-icon"]'));
  assert.deepEqual(await finishCurrentBuild(root, revision, cargo), expected);
  assert.equal(await readFile(join(root, cargoPath), 'utf8'), cargo);
});

test('WGS finish refuses arbitrary Cargo changes and retains the changed file for inspection', async t => {
  const {root, revision} = await sourceFixture(t);
  const changed = cargo.replace('version = "1.0.0"', 'version = "2.0.0"');
  await writeFile(join(root, cargoPath), changed);
  await assert.rejects(finishCurrentBuild(root, revision, cargo), {code: 'ERR_ASSERTION'});
  assert.equal(await readFile(join(root, cargoPath), 'utf8'), changed);
});

test('WGS finish detects source drift outside the Cargo manifest after restoring its allowed change', async t => {
  const {root, revision} = await sourceFixture(t);
  await writeFile(join(root, cargoPath), cargo.replace('features = ["tray-icon"]', 'features = ["macos-private-api", "tray-icon"]'));
  await writeFile(join(root, 'apps/web/src/main.ts'), 'export const value = 9;\n');
  await assert.rejects(finishCurrentBuild(root, revision, cargo), {code: 'ERR_ASSERTION'});
  assert.equal(await readFile(join(root, cargoPath), 'utf8'), cargo);
});

async function inputFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lingji-wgs-input-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = {files: [{path: 'package.json', sha256: releaseHash('{}')} ]};
  source.sha256 = releaseHash(JSON.stringify(source.files));
  const expected = {version: '1.2.3', sourceRevision: 'a'.repeat(40), source};
  const files = [];
  for (const name of ['windows-setup.exe', 'resources.tar.gz', 'lingji-ui-tests.exe']) {
    const bytes = Buffer.from(`synthetic ${name}`);
    await writeFile(join(directory, name), bytes);
    files.push({name, bytes: bytes.length, sha256: releaseHash(bytes)});
  }
  const receipt = {...expected, builder: 'wgs', sourceBuildMode: 'guarded-current-directory', sourceVerifiedAfterBuild: true, target: 'x86_64-pc-windows-msvc', files};
  const save = value => writeFile(join(directory, 'wgs-windows-input.json'), JSON.stringify(value));
  await save(receipt);
  return {directory, expected, receipt, save};
}

test('WGS input accepts exactly the three expected files with matching source and measured bytes', async t => {
  const {directory, expected, receipt} = await inputFixture(t);
  const actual = await verifyWgsInput(directory, expected);
  assert.deepEqual(actual, receipt);
});

test('WGS raw application input is optional for legacy installers and hash-verified for MSIX', async t => {
  const {directory, expected, receipt, save} = await inputFixture(t);
  const bytes = Buffer.from('fixed WGS executable');
  await writeFile(join(directory, 'windows-app.exe'), bytes);
  const next = {...receipt, files: [...receipt.files, {name: 'windows-app.exe', bytes: bytes.length, sha256: releaseHash(bytes)}]};
  await save(next);
  assert.deepEqual(await verifyWgsInput(directory, expected), next);
  await writeFile(join(directory, 'windows-app.exe'), 'changed');
  await assert.rejects(verifyWgsInput(directory, expected));
  await save({...next, files: next.files.filter(file => file.name !== 'resources.tar.gz')});
  await assert.rejects(verifyWgsInput(directory, expected));
});

test('WGS input rejects wrong identity, source provenance, target, size, digest, and unexpected paths', async t => {
  const {directory, expected, receipt, save} = await inputFixture(t);
  const invalid = [
    {...receipt, version: '9.9.9'},
    {...receipt, sourceRevision: 'b'.repeat(40)},
    {...receipt, source: {...receipt.source, sha256: '0'.repeat(64)}},
    {...receipt, builder: 'elsewhere'},
    {...receipt, sourceBuildMode: 'mutable-directory'},
    {...receipt, sourceVerifiedAfterBuild: false},
    {...receipt, target: 'x86_64-unknown-linux-gnu'},
    {...receipt, files: receipt.files.slice(1)},
    {...receipt, files: receipt.files.map((file, i) => i ? file : {...file, name: '../windows-setup.exe'})},
    {...receipt, files: receipt.files.map((file, i) => i ? file : {...file, bytes: file.bytes + 1})},
    {...receipt, files: receipt.files.map((file, i) => i ? file : {...file, sha256: '0'.repeat(64)})},
  ];
  for (const value of invalid) {
    await save(value);
    await assert.rejects(verifyWgsInput(directory, expected), `accepted altered receipt ${JSON.stringify(value)}`);
  }
  await save(receipt);
  await writeFile(join(directory, receipt.files[0].name), 'tampered');
  await assert.rejects(verifyWgsInput(directory, expected));
});

test('WGS input rejects duplicate file entries even if all three unique names remain', async t => {
  const {directory, expected, receipt, save} = await inputFixture(t);
  await save({...receipt, files: [...receipt.files, receipt.files[0]]});
  await assert.rejects(verifyWgsInput(directory, expected));
});

test('WGS input rejects an inconsistent source list even if its claimed source digest is unchanged', async t => {
  const {directory, expected, receipt, save} = await inputFixture(t);
  await save({...receipt, source: {...receipt.source, files: [{path: 'unexpected-source.mjs', sha256: '0'.repeat(64)}]}});
  await assert.rejects(verifyWgsInput(directory, expected));
});

test('WGS collecting two releases in one directory removes the previous installer and keeps the current receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-wgs-collector-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const collector = fileURLToPath(new URL('../scripts/collect-preview-artifacts.mjs', import.meta.url));
  for (const version of ['0.3.0', '0.3.1']) {
    const directory = join(root, 'dist/releases', version, 'linux-x64');
    const artifact = `Lingji-${version}-linux-amd64.deb`;
    const metadata = {version, artifact, sourceRevision: 'a'.repeat(40), sourceDirty: false, frozenSourceBuild: false, sourceBuildMode: 'guarded-current-directory', builder: 'wgs', sourceVerifiedAfterBuild: true};
    await mkdir(directory, {recursive: true});
    for (const [name, contents] of [[artifact, `synthetic ${version}`], ['SHA256SUMS-linux-x64.txt', `${version} fixture`], ['release-linux-x64.json', JSON.stringify(metadata)], ['package-smoke-linux-x64.json', '{}']]) {
      await writeFile(join(directory, name), contents);
    }
    execFileSync(process.execPath, [collector, 'linux'], {cwd: root, env: {...process.env, RELEASE_VERSION: version, SOURCE_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'synthetic/fixture', GITHUB_RUN_ID: '123', WORKFLOW_SHA: 'b'.repeat(40)}, stdio: ['ignore', 'pipe', 'pipe']});
  }
  const staged = join(root, 'preview-artifacts');
  assert.deepEqual((await readdir(staged)).sort(), ['Lingji-0.3.1-linux-amd64.deb', 'SHA256SUMS-linux-x64.txt', 'package-smoke-linux-x64.json', 'release-linux-x64.json'].sort());
  assert.equal(await readFile(join(staged, 'Lingji-0.3.1-linux-amd64.deb'), 'utf8'), 'synthetic 0.3.1');
  const current = JSON.parse(await readFile(join(staged, 'release-linux-x64.json'), 'utf8'));
  assert.equal(current.version, '0.3.1');
  assert.equal(current.sourceRevision, 'a'.repeat(40));
  assert.equal(current.ci.runId, '123');
});


test('WGS Store candidates require all paired artifacts and verify every transferred byte', async t => {
  const {directory, expected, receipt: value, save} = await inputFixture(t);
  const extra = [];
  for (const name of ['windows-app.exe', 'windows-store-unsigned.msix', 'store-package.json']) {
    const bytes = Buffer.from(`fixture ${name}`);
    await writeFile(join(directory, name), bytes);
    extra.push({name, bytes: bytes.length, sha256: releaseHash(bytes)});
  }
  const complete = {...value, files: [...value.files, ...extra]};
  await save(complete);
  assert.deepEqual(await verifyWgsInput(directory, expected), complete);
  await save({...complete, files: complete.files.filter(file => file.name !== 'store-package.json')});
  await assert.rejects(verifyWgsInput(directory, expected));
  await save(complete);
  await writeFile(join(directory, 'windows-store-unsigned.msix'), 'changed');
  await assert.rejects(verifyWgsInput(directory, expected));
});


test('Windows copies only the exact WGS Store package and rejects altered identity', async t => {
  const {root} = await sourceFixture(t);
  const identity = storeIdentity({storeId: '9TESTMSIX001', name: 'Fixture.Lingji', publisher: 'CN=Fixture Publisher', displayName: 'Fixture', appDisplayName: 'Fixture Lingji'});
  const configDirectory = join(root, 'apps/desktop/src-tauri');
  await writeFile(join(configDirectory, 'microsoft-store.json'), JSON.stringify(identity));
  await writeFile(join(configDirectory, 'tauri.preview.conf.json'), JSON.stringify({version: '0.3.30'}));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.test', 'commit', '-m', 'fixture identity');
  const sourceRevision = git('rev-parse', 'HEAD');
  const source = await snapshotReleaseSource({root, ref: sourceRevision});
  const {directory, receipt, save} = await inputFixture(t);
  const packageBytes = Buffer.from('synthetic unsigned MSIX');
  const metadata = {version: '0.3.30', packageVersion: msixVersion('0.3.30'), sourceRevision, sourceDigest: source.sha256, builder: 'wgs', identity, signed: false, published: false, artifact: {name: 'windows-store-unsigned.msix', size: packageBytes.length, sha256: releaseHash(packageBytes)}};
  const files = [...receipt.files];
  for (const [name, bytes] of [['windows-app.exe', Buffer.from('synthetic exe')], ['windows-store-unsigned.msix', packageBytes], ['store-package.json', Buffer.from(JSON.stringify(metadata))]]) {
    await writeFile(join(directory, name), bytes);
    files.push({name, bytes: bytes.length, sha256: releaseHash(bytes)});
  }
  const updateReceipt = () => save({...receipt, version: metadata.version, sourceRevision, source, files});
  await updateReceipt();
  const destination = join(root, 'submission');
  await copyWindowsMsix({root, prebuilt: directory, destination, sourceRevision});
  assert.deepEqual(await readFile(join(destination, metadata.artifact.name)), packageBytes);
  metadata.identity = {...identity, name: 'Another.Product'};
  const altered = Buffer.from(JSON.stringify(metadata));
  await writeFile(join(directory, 'store-package.json'), altered);
  Object.assign(files.find(file => file.name === 'store-package.json'), {bytes: altered.length, sha256: releaseHash(altered)});
  await updateReceipt();
  await assert.rejects(copyWindowsMsix({root, prebuilt: directory, destination: join(root, 'rejected'), sourceRevision}));
});
