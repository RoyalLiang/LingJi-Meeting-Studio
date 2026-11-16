import assert from 'node:assert/strict';

export function versionParts(value) {
  assert.match(value,/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/,'Expected X.Y.Z or X.Y.Z.revision');
  const parts=value.split('.').map(Number);
  assert.ok(parts.every(Number.isSafeInteger),'Version components must be integers');
  assert.ok(parts.slice(0,3).every(part=>part<=65535),'Version exceeds platform limits');
  if(parts.length===4){assert.ok(parts[3]<=99,'Revision must be 0..99');assert.ok(parts[2]*100+parts[3]<=65535,'Encoded patch exceeds 65535');}
  return parts;
}
export function nativeVersion(value) {
  const [major,minor,patch,revision]=versionParts(value);
  return `${major}.${minor}.${revision===undefined?patch:patch*100+revision}`;
}
export function previewReleaseConfig(config,manifest) {
  const version=manifest.releaseVersion||config.version;
  assert.equal(nativeVersion(version),config.version,'Product and native versions disagree');
  return {...config,version,nativeVersion:config.version};
}
