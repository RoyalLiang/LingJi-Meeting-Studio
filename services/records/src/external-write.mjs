import { requireThat } from '../../../packages/records/src/record.mjs';

// The feature's durable record is the journal: it shares source retention and
// needs no second content store. A receipt is provider evidence, never a guess.
export async function externalWrite({key,fingerprint,load,save,guard,reconcile,execute}) {
  await guard();let state=(await load()).writes?.[key];
  if(state)requireThat(state.fingerprint===fingerprint,'external_write_conflict',409);
  else {state={fingerprint,status:'intent',createdAt:new Date().toISOString()};await save(key,state);}
  if(state.status==='confirmed')return state.receipt;
  const remote=await reconcile({attempted:Boolean(state.attemptedAt),state});
  await guard();
  if(remote.status==='confirmed'){
    await save(key,{...state,status:'confirmed',receipt:remote.receipt,confirmedAt:new Date().toISOString()});return remote.receipt;
  }
  requireThat(remote.status==='absent','external_write_unknown',409);
  state={...state,status:'attempting',attemptedAt:new Date().toISOString()};await save(key,state);await guard();
  const receipt=await execute();
  await save(key,{...state,status:'confirmed',receipt,confirmedAt:new Date().toISOString()});return receipt;
}
