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
  return {
    model_name: 'bigmodel', enable_itn: true, enable_punc: true,
    show_utterances: true, ...(secondPass ? { enable_nonstream: true } : {}),
    ...(hotwords.length ? { corpus: { context: JSON.stringify({ hotwords }) } } : {}),
  };
}
