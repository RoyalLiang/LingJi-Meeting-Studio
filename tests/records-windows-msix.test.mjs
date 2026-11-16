import test from 'node:test';
import assert from 'node:assert/strict';
import {msixManifest, msixVersion, storeIdentity} from '../scripts/windows-msix.mjs';

const env = {storeId: '9TESTMSIX001', name: '12345.LingJi', publisher: 'CN=12345678-1234-1234-1234-123456789abc', displayName: '聆记 & "个人"', appDisplayName: '聆记 LingJi'};

test('Store identity must be reserved and complete rather than guessed from the application name', () => {
  assert.throws(() => storeIdentity({}));
  const identity = storeIdentity(env);
  assert.equal(identity.name, env.name);
  assert.equal(identity.publisher, env.publisher);
  for (const key of Object.keys(env)) assert.throws(() => storeIdentity({...env, [key]: ''}));
  for (const name of ['../Lingji', 'a', 'app/name', 'app name', 'a'.repeat(51)]) assert.throws(() => storeIdentity({...env, name}));
  for (const publisher of ['Royal', 'CN=<injected>', 'CN=name\nPublisher=other']) assert.throws(() => storeIdentity({...env, publisher}));
});

test('MSIX maps zero-major product releases monotonically to valid Store versions with a zero fourth part', () => {
  assert.equal(msixVersion('0.3.30'), '1.3.30.0');
  assert.equal(msixVersion('1.0.0'), '2.0.0.0');
  assert.equal(msixVersion('65534.65535.65535'), '65535.65535.65535.0');
  for (const version of ['65535.0.0', 'v0.3.30', '0.3.30.1', '0.03.30', '1.2.65536', '../1.2', '1.2']) assert.throws(() => msixVersion(version));
});

test('Store manifest runs the existing desktop executable with explicit capabilities and escaped publisher text', () => {
  const manifest = msixManifest('0.3.30', storeIdentity(env));
  assert.ok(manifest.includes(`Name="${env.name}" Publisher="${env.publisher}" Version="1.3.30.0"`));
  assert.ok(manifest.includes('Executable="tts-client.exe" EntryPoint="Windows.FullTrustApplication"'));
  assert.ok(manifest.includes('<PublisherDisplayName>聆记 &amp; &quot;个人&quot;</PublisherDisplayName>'));
  assert.match(manifest, /Name="runFullTrust"/);
  assert.match(manifest, /Name="microphone"/);
  assert.match(manifest, /MinVersion="10\.0\.19041\.0"/);
  assert.doesNotMatch(manifest, /setup\.exe|broadFileSystemAccess|AppxSignature/);
});
