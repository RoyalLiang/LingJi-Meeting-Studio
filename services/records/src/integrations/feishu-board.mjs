import {requireThat} from '../../../../packages/records/src/record.mjs';
import {minutesBoard} from '../../../../packages/records/src/minutes-presentation.mjs';

// Shapes and text remain individually editable; preview uses these exact nodes.
export function feishuBoard(minutes, options={}) {
  const nodes=minutesBoard(minutes,options);
  requireThat(nodes.length<=3000&&Buffer.byteLength(JSON.stringify(nodes))<=500000,'feishu_document_too_large',400);
  return nodes;
}
