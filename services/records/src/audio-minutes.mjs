import { minutesCoreInstructions, minutesQualityInstructions } from '../../../packages/records/src/minutes-quality.mjs';

export const audioMinutesInstructions = `${minutesCoreInstructions}
音频是直接理解的输入；仅总结本次给定转录片段覆盖的内容，其他音频只作上下文。人工修订是文字依据，不得被音频覆盖。不确定内容不补造。
${minutesQualityInstructions}`;
