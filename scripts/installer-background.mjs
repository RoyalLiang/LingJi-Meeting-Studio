import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';

const directory=resolve(process.argv[2]?.startsWith('--')?'apps/desktop/src-tauri/installer':process.argv[2]||'apps/desktop/src-tauri/installer');
const width=800,height=520,stride=width*3;
const waves=[{y:.49,a:.055,p:.4,alpha:.08},{y:.59,a:.075,p:2.0,alpha:.10},{y:.69,a:.06,p:3.4,alpha:.13},{y:.80,a:.055,p:5.0,alpha:.12}];
const curve=(wave,x)=>height*(wave.y+wave.a*Math.sin(x/width*Math.PI*2*.85+wave.p));
const pixels=Buffer.alloc(stride*height);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const t=y/height;let rgb=[247-12*t,250-7*t,248-11*t];
  for(const wave of waves){const opacity=wave.alpha*Math.max(0,Math.min(1,(y-curve(wave,x)+1.5)/3));rgb=rgb.map((v,i)=>v*(1-opacity)+[65,143,112][i]*opacity);}
  const at=(height-1-y)*stride+x*3;pixels[at]=Math.round(rgb[2]);pixels[at+1]=Math.round(rgb[1]);pixels[at+2]=Math.round(rgb[0]);
}
const header=Buffer.alloc(54);header.write('BM');header.writeUInt32LE(header.length+pixels.length,2);header.writeUInt32LE(54,10);header.writeUInt32LE(40,14);header.writeInt32LE(width,18);header.writeInt32LE(height,22);header.writeUInt16LE(1,26);header.writeUInt16LE(24,28);header.writeUInt32LE(pixels.length,34);
const bitmap=Buffer.concat([header,pixels]);
const paths=waves.map(w=>{const points=Array.from({length:101},(_,i)=>{const x=i*width/100;return `${i?'L':'M'}${x.toFixed(2)} ${curve(w,x).toFixed(2)}`;}).join(' ');return `<path d="${points} L${width} ${height} L0 ${height}Z" fill="#418f70" opacity="${w.alpha}"/>`;}).join('\n');
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>聆记安装器全幅玉绿色背景</title><defs><linearGradient id="paper" x2="0" y2="1"><stop stop-color="#f7faf8"/><stop offset="1" stop-color="#ebf3ed"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#paper)"/>${paths}</svg>\n`;
if(process.argv.includes('--check'))assert.deepEqual(await readFile(join(directory,'background.bmp')),bitmap,'Regenerate installer background asset');
else{await mkdir(directory,{recursive:true});await writeFile(join(directory,'background.bmp'),bitmap);await writeFile(join(directory,'background.svg'),svg);}
console.log(JSON.stringify({width,height,bytes:bitmap.length,check:process.argv.includes('--check')}));
