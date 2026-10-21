import { requireThat } from '../../../packages/records/src/record.mjs';

// These are recognition hints, never substitutions in already saved transcripts.
export function parseAsrHotwords(value = '') {
  requireThat(typeof value === 'string', 'invalid_asr_hotwords', 400);
  const words = [...new Set(value.split(/[,，;；\n]+/u).map(word => word.trim()).filter(Boolean))];
  // Keep inline hints small for the streaming API's limited context budget.
  requireThat(words.length <= 100 && words.every(word => [...word].length <= 50) && words.reduce((size, word) => size + [...word].length, 0) <= 100, 'invalid_asr_hotwords', 400);
  return words.map(word => ({ word }));
}

export function doubaoRecognitionRequest(config, { secondPass = true } = {}) {
  const hotwords = parseAsrHotwords(config.DOUBAO_ASR_HOTWORDS);
  const context = parseAsrContext(config.DOUBAO_ASR_CONTEXT);
  requireThat(!context || secondPass, 'asr_context_requires_second_pass', 400);
  return {
    model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false,
    show_utterances: true, ...(secondPass ? { enable_nonstream: true } : {}),
    ...(hotwords.length || context ? { corpus: { context: JSON.stringify({ ...(hotwords.length ? {hotwords} : {}),
      ...(context ? {context_type:'dialog_ctx',context_data:[{text:context}]} : {}) }) } } : {}),
  };
}
export function parseAsrContext(value = '') {
  requireThat(typeof value === 'string' && !/[\u0000-\u001f]/u.test(value), 'invalid_asr_context', 400);
  const text=value.trim();
  // Engineering bounds, not a claim about the provider tokenizer's 800-token limit.
  requireThat([...text].length<=400 && Buffer.byteLength(text)<=1600, 'invalid_asr_context', 400);
  return text;
}

// Scene context applies only to the supported Chinese/English second pass.
// Keep other language recordings working when a global scene hint is saved.
export function doubaoRecognitionForLanguage(config, language) {
  const secondPass=['zh','en','zhen'].includes(language) && new URL(config.DOUBAO_ASR_URL).pathname.endsWith('/bigmodel_async');
  return doubaoRecognitionRequest(secondPass?config:{...config,DOUBAO_ASR_CONTEXT:''},{secondPass});
}
export function doubaoAudioConfig(config, language) {
  const supportsLanguage=new URL(config.DOUBAO_ASR_URL).pathname.endsWith('/bigmodel_nostream');
  return {format:'pcm',codec:'raw',rate:16000,bits:16,channel:1,
    ...(supportsLanguage ? {language:({zh:'zh-CN',en:'en-US',ja:'ja-JP'}[language]||language)} : {})};
}
