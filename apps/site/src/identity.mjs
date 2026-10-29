import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ShareContentError } from '../../../packages/records/src/published-content.mjs';

const keys = new Map();
export async function verifyPublisherToken(token, key, issuer, audience) {
  const {payload}=await jwtVerify(token,key,{issuer,audience,algorithms:['RS256'],requiredClaims:['exp','sub','aud','iss']});
  if(typeof payload.sub!=='string' || !payload.sub || payload.sub.length>256)throw new Error('invalid_subject');
  return {id:payload.sub};
}
export async function publisher(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN, audience = env.ACCESS_AUD;
  if (typeof team !== 'string' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team) || typeof audience !== 'string' || !audience || audience.length > 512) throw new ShareContentError('publishing_not_configured',503);
  const token=request.headers.get('cf-access-jwt-assertion');
  if(!token || token.length>16384)throw new ShareContentError('publisher_login_required',401);
  let jwks=keys.get(team);
  if(!jwks){jwks=createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`),{timeoutDuration:5000,cacheMaxAge:600000});keys.set(team,jwks);}
  try {
    return await verifyPublisherToken(token,jwks,`https://${team}`,audience);
  } catch {throw new ShareContentError('publisher_login_required',401);}
}
