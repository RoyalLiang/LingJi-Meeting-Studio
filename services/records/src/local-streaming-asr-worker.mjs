import {createRequire} from 'node:module';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {LOCAL_STREAMING_ASR_MODEL} from './local-asr.mjs';

const directory=process.argv[2];if(!directory)process.exit(1);
const require=createRequire(join(directory,'package.json')),sherpa=require('sherpa-onnx-node');
const recognizer=new sherpa.OnlineRecognizer({
  featConfig:{sampleRate:16000,featureDim:80},
  modelConfig:{transducer:{encoder:join(directory,'zipformer/encoder-epoch-99-avg-1.int8.onnx'),decoder:join(directory,'zipformer/decoder-epoch-99-avg-1.int8.onnx'),joiner:join(directory,'zipformer/joiner-epoch-99-avg-1.int8.onnx')},tokens:join(directory,'zipformer/tokens.txt'),numThreads:2,provider:'cpu',debug:0},
  decodingMethod:'greedy_search',enableEndpoint:false,
});
const streams=new Map(),limit=Math.max(1,Math.min(32,Number(process.env.RECORD_ASR_MAX_STREAMS||8)||8));
const reply=value=>process.stdout.write(JSON.stringify(value)+'\n');
reply({protocol:1,ready:true,model:LOCAL_STREAMING_ASR_MODEL});
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
  if(line.length>1300000)process.exit(1);
  let request;
  try{
    request=JSON.parse(line);const context=request.context;
    if(!Number.isSafeInteger(request.id)||typeof request.pcm!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(request.pcm)||!context||typeof context.key!=='string'||!context.key.length||context.key.length>200||!Number.isSafeInteger(context.sampleOffset)||context.sampleOffset<0||!Number.isSafeInteger(context.sampleOffset+Buffer.byteLength(request.pcm,'base64')/2)||typeof context.final!=='boolean')process.exit(1);
    const bytes=Buffer.from(request.pcm,'base64');if(!bytes.length||bytes.length>960000||bytes.length%2)process.exit(1);
    const end=context.sampleOffset+bytes.length/2;let state=streams.get(context.key);
    if(!state){
      let stream;
      if(streams.size>=limit){const key=streams.keys().next().value;stream=streams.get(key).stream;streams.delete(key);recognizer.reset(stream);}else stream=recognizer.createStream();
      state={stream,start:context.sampleOffset,end:context.sampleOffset,closed:false};
    }
    if(state.start!==context.sampleOffset||end<state.end||state.closed&&end>state.end){recognizer.reset(state.stream);state.start=context.sampleOffset;state.end=context.sampleOffset;state.closed=false;}
    const skip=Math.max(0,state.end-context.sampleOffset),samples=new Float32Array(bytes.length/2-skip);
    for(let i=0;i<samples.length;i++)samples[i]=bytes.readInt16LE((skip+i)*2)/32768;
    if(samples.length){state.stream.acceptWaveform({samples,sampleRate:16000});state.end=end;}
    if(context.final&&!state.closed){state.stream.inputFinished();state.closed=true;}
    while(recognizer.isReady(state.stream))recognizer.decode(state.stream);
    streams.delete(context.key);streams.set(context.key,state);
    const result=recognizer.getResult(state.stream);
    reply({id:request.id,text:result.text||'',startSample:state.start,endSample:state.end});
  }catch{reply({id:request?.id,error:'local_asr_inference_failed'});}
}
