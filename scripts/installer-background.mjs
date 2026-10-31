import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';

const directory=resolve(process.argv[2]?.startsWith('--')?'apps/desktop/src-tauri/installer':process.argv[2]||'apps/desktop/src-tauri/installer');
const width=800,height=520,stride=width*3;
const pixels=Buffer.alloc(stride*height);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const gx=x/width,gy=(y+32)/height;
  const glow=Math.exp(-((gx-.94)**2/.23+(gy-.38)**2/.42));
  const low=Math.exp(-((gx-.82)**2/.7+(gy-1.12)**2/.17));
  const a=Math.min(1,glow*.46+low*.35);
  let rgb=[250,251,247].map((v,i)=>v*(1-a)+[226,240,230][i]*a);
  for(let j=0;j<8;j++)if(Math.abs(x-(734+j*18+22*Math.sin((y+32)/130+j*.23)))<.5)rgb=rgb.map((v,i)=>v*243/255+[84,145,113][i]*12/255);
  const at=(height-1-y)*stride+x*3;pixels[at]=Math.round(rgb[2]);pixels[at+1]=Math.round(rgb[1]);pixels[at+2]=Math.round(rgb[0]);
}
const header=Buffer.alloc(54);header.write('BM');header.writeUInt32LE(header.length+pixels.length,2);header.writeUInt32LE(54,10);header.writeUInt32LE(40,14);header.writeInt32LE(width,18);header.writeInt32LE(height,22);header.writeUInt16LE(1,26);header.writeUInt16LE(24,28);header.writeUInt32LE(pixels.length,34);
const bitmap=Buffer.concat([header,pixels]);
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520" viewBox="0 0 800 520"><title>聆记安装器暖白玉绿全幅背景</title><defs><radialGradient id="paper" cx="94%" cy="38%" r="100%"><stop stop-color="#edf5ed"/><stop offset="1" stop-color="#fafbf7"/></radialGradient></defs><rect width="800" height="520" fill="url(#paper)"/>${Array.from({length:8},(_,j)=>`<path d="${Array.from({length:100},(_,i)=>{const y=i*520/99;return `${i?'L':'M'}${(734+j*18+22*Math.sin((y+32)/130+j*.23)).toFixed(2)} ${y.toFixed(2)}`;}).join(' ')}" fill="none" stroke="#549171" stroke-opacity=".047"/>`).join('')}</svg>\n`;
if(process.argv.includes('--check'))assert.deepEqual(await readFile(join(directory,'background.bmp')),bitmap,'Regenerate installer background asset');
else{await mkdir(directory,{recursive:true});await writeFile(join(directory,'background.bmp'),bitmap);await writeFile(join(directory,'background.svg'),svg);}
console.log(JSON.stringify({width,height,bytes:bitmap.length,check:process.argv.includes('--check')}));
