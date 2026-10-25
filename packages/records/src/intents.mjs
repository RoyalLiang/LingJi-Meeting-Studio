import { requireThat, emit } from './record.mjs';
const kinds = new Set(['decision', 'action', 'proposal', 'question', 'withdrawal']);
// Conservative local hints are useful without a model, and are always labelled as rules.
export function ruleIntents(snapshot) {
  return { items: snapshot.flatMap(segment => {
    const text = segment.text;
    const kind = /[？?]|是否|怎么|为什么|(?:…|\.\.\.)\s*$/.test(text) ? 'question'
      : /如果|假如|假设|要是|除非|前提|可能|也许|暂定|备选|建议|提议|不如|可以考虑|据说|听说|客户说|有人说/.test(text) ? 'proposal'
      : /取消|撤回|作废|(?:不再|不要|不用|暂不|别).{0,8}(?:发|执行|上线|发布|安排|提交|推进|采用)/.test(text) ? 'withdrawal'
      : /决定|确定|达成一致|同意采用|就按/.test(text) ? 'decision'
      : /负责|跟进|待办|下一步|请.{1,30}(完成|提交|确认)|我来/.test(text) ? 'action' : null;
    return kind ? [{ kind, text: text.slice(0, 2000), evidence: [{ segmentId: segment.id, revision: segment.revision }] }] : [];
  }).slice(-50) };
}
export function commitIntents(record, snapshot, result, method, revision, generation) {
  if (record.deleted || record.generation !== generation || record.transcriptRevision !== revision) return false;
  requireThat(Array.isArray(result.items) && result.items.length <= 50, 'invalid_intents', 502);
  for (const item of result.items) {
    requireThat(kinds.has(item.kind) && typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 2000, 'invalid_intent_item', 502);
    requireThat(Array.isArray(item.evidence) && item.evidence.length > 0 && item.evidence.length <= 20, 'intent_evidence_required', 502);
    for (const ref of item.evidence) requireThat(snapshot.some(s => s.id === ref.segmentId && s.revision === ref.revision), 'invalid_intent_evidence', 502);
  }
  record.insights = { transcriptRevision: revision, method, items: result.items, evidenceSnapshot: snapshot, updatedAt: new Date().toISOString() };
  delete record.intentError;
  record.usage.llmTokens += Number.isFinite(result.tokens) && result.tokens > 0 ? result.tokens : 0;
  emit(record, 'intents.committed', { transcriptRevision: revision });
  return true;
}
