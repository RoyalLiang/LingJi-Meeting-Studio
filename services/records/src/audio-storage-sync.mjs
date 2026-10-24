import {open} from 'node:fs/promises';

// Windows FlushFileBuffers requires GENERIC_WRITE and rejects a directory fsync.
// After linking the already-synced object, flush its file handle before the ACK.
// POSIX platforms retain the parent-directory durability barrier.
export async function flushAudioObject(file,directory,platform=process.platform){
  const handle=await open(platform==='win32'?file:directory,platform==='win32'?'r+':'r');
  try{await handle.sync();}finally{await handle.close();}
}
