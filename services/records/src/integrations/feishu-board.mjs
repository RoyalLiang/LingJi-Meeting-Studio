import {requireThat} from '../../../../packages/records/src/record.mjs';
import {compileMeetingMinutesBoard,compileMeetingMinutesPages,minutesSkillDsl} from '../../../../packages/records/src/meeting-minutes-skill.mjs';

// Shapes and text remain individually editable; preview uses these exact nodes.
export function feishuBoard(minutes, options={}) {
  const nodes=compileMeetingMinutesBoard(minutesSkillDsl(minutes,options),options);
  requireThat(nodes.length<=3000&&Buffer.byteLength(JSON.stringify(nodes))<=500000,'feishu_document_too_large',400);
  return nodes;
}

export function feishuBoardPages(minutes,options={}) {
  return compileMeetingMinutesPages(minutesSkillDsl(minutes,options),options);
}
