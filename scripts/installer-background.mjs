import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';

const directory=resolve(process.argv[2]?.startsWith('--')?'apps/desktop/src-tauri/installer':process.argv[2]||'apps/desktop/src-tauri/installer');
const width=800,height=520,stride=width*3;
const pixels=Buffer.alloc(stride*height);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const distance=Math.hypot(x-830,y-110),coverage=Math.max(0,Math.min(1,1.15-Math.abs(distance-340)));
  const rgb=[239,244,237].map((value,i)=>value*(1-coverage)+[196,217,198][i]*coverage);
  const at=(height-1-y)*stride+x*3;pixels[at]=Math.round(rgb[2]);pixels[at+1]=Math.round(rgb[1]);pixels[at+2]=Math.round(rgb[0]);
}
const header=Buffer.alloc(54);header.write('BM');header.writeUInt32LE(header.length+pixels.length,2);header.writeUInt32LE(54,10);header.writeUInt32LE(40,14);header.writeInt32LE(width,18);header.writeInt32LE(height,22);header.writeUInt16LE(1,26);header.writeUInt16LE(24,28);header.writeUInt32LE(pixels.length,34);
const bitmap=Buffer.concat([header,pixels]);
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520" viewBox="0 0 800 520"><title>聆记安装器浅绿圆弧背景</title><rect width="800" height="520" fill="#eff4ed"/><circle cx="830" cy="110" r="340" fill="none" stroke="#c4d9c6" stroke-width="1.2"/></svg>\n`;
if(process.argv.includes('--check'))assert.deepEqual(await readFile(join(directory,'background.bmp')),bitmap,'Regenerate installer background asset');
else{await mkdir(directory,{recursive:true});await writeFile(join(directory,'background.bmp'),bitmap);await writeFile(join(directory,'background.svg'),svg);}
console.log(JSON.stringify({width,height,bytes:bitmap.length,check:process.argv.includes('--check')}));
