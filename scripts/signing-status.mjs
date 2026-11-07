import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export function signingStatus({identities='',env={},tools={}}={}){
  const developerIds=identities.split('\n').filter(line=>/Developer ID Application:/.test(line)).length;
  const selected=Boolean(env.APPLE_SIGNING_IDENTITY&&env.APPLE_SIGNING_IDENTITY!=='-'&&identities.split('\n').some(line=>line.includes('Developer ID Application:')&&line.includes(env.APPLE_SIGNING_IDENTITY)));
  const notarization=Boolean(env.TTS_NOTARY_PROFILE||env.APPLE_API_KEY&&env.APPLE_API_ISSUER&&env.APPLE_API_KEY_PATH);
  return {mode:'configuration-preflight',trustedArtifactVerified:false,
    macOS:{developerIdCount:developerIds,identitySelected:selected,notarizationConfigured:notarization,missing:[...(!developerIds?['Developer ID Application certificate / paid Apple membership']:[]),...(!selected?['APPLE_SIGNING_IDENTITY']:[]),...(!notarization?['notarization credentials in Keychain or protected CI secrets']:[])]},
    windows:{providerConfigured:Boolean(env.TTS_WINDOWS_SIGNING_PROVIDER),profileConfigured:Boolean(env.TTS_WINDOWS_CERTIFICATE_PROFILE),missing:[...(!env.TTS_WINDOWS_SIGNING_PROVIDER?['publicly trusted individual code-signing enrollment']:[]),...(!env.TTS_WINDOWS_CERTIFICATE_PROFILE?['validated certificate / cloud signing profile']:[])]},
    linux:{gpgAvailable:Boolean(tools.gpg),keyConfigured:Boolean(env.TTS_GPG_SIGNING_KEY),missing:[...(!tools.gpg?['GnuPG']:[]),...(!env.TTS_GPG_SIGNING_KEY?['release signing key and public-key distribution']:[])]},
    mobile:{iosTeamConfigured:Boolean(env.APPLE_TEAM_ID),androidKeystoreConfigured:Boolean(env.ANDROID_KEYSTORE_PATH),projectStatus:'feasibility-only; no mobile app was built'}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let identities='';if(process.platform==='darwin')try{identities=execFileSync('security',['find-identity','-v','-p','codesigning'],{encoding:'utf8'});}catch{/* No usable identity. */}
  let gpg=false;try{execFileSync('gpg',['--version'],{stdio:'ignore'});gpg=true;}catch{/* Optional until a release key is provisioned. */}
  console.log(JSON.stringify(signingStatus({identities,env:process.env,tools:{gpg}}),null,2));
}
