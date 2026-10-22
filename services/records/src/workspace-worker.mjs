import { randomUUID } from 'node:crypto';
import { analysisMessages, inputHash, retainedRecords, validateWorkspaceAnalysis } from '../../../packages/records/src/workspaces.mjs';
import { completeJson, providerStatus } from './providers.mjs';

export async function processWorkspaceAnalysis(repo, config, providers = {}) {
  const jobs = await repo.list('workspace-analysis');
  for (const candidate of jobs) {
    const records = retainedRecords(await repo.list(), candidate.owner, candidate.scope);
    if (inputHash(records) !== candidate.inputHash) {
      if (candidate.status !== 'stale' || candidate.snapshot?.length || candidate.result) await repo.change(candidate.id, job => {
        if (job.runId === candidate.runId) Object.assign(job, { status: 'stale', snapshot: [], preview: '', result: null, fence: null, updatedAt: new Date().toISOString() });
      });
      continue;
    }
    if (candidate.status !== 'queued' && !(candidate.status === 'running' && candidate.lease < Date.now())) continue;
    let claimed = false; const fence = randomUUID();
    await repo.change(candidate.id, job => {
      if (job.runId !== candidate.runId || (job.status !== 'queued' && !(job.status === 'running' && job.lease < Date.now()))) return;
      Object.assign(job, { status: 'running', fence, lease: Date.now() + 150000, updatedAt: new Date().toISOString() }); claimed = true;
    });
    if (!claimed) continue;
    const controller = new AbortController(); let checking = false, timer, lastPreview = 0, draft = '';
    const valid = async () => {
      const current = await repo.get(candidate.id);
      return current?.fence === fence && current.status === 'running' && inputHash(retainedRecords(await repo.list(), candidate.owner, candidate.scope)) === candidate.inputHash;
    };
    try {
      if (!providers.completeJson && !providerStatus(config).textMinutes) throw Object.assign(new Error('minutes_not_configured'), { code: 'minutes_not_configured' });
      timer = setInterval(async () => {
        if (checking) return; checking = true;
        try { if (!(await valid())) controller.abort(); } catch { controller.abort(); } finally { checking = false; }
      }, 750); timer.unref?.();
      const output = await (providers.completeJson || completeJson)(analysisMessages(candidate.snapshot), config, {
        signal: controller.signal,
        onDelta: async (delta, runtime) => {
          draft += delta;
          if (Date.now() - lastPreview < 250) return;
          if (!(await valid())) { controller.abort(); throw Object.assign(new Error('analysis_stale'), { code: 'analysis_stale' }); }
          lastPreview = Date.now();
          await repo.change(candidate.id, job => {
            if (job.fence === fence && job.status === 'running') Object.assign(job, { preview: draft.slice(0, 60000), runtime, updatedAt: new Date().toISOString() });
          });
        }
      });
      if (!(await valid())) continue;
      const result = validateWorkspaceAnalysis(output, candidate.snapshot);
      await repo.change(candidate.id, job => {
        if (job.fence === fence && job.status === 'running') Object.assign(job, { status: 'completed', result, snapshot: [], preview: '', runtime: { ...output.runtime, usageTokens: output.usageTokens || 0, model: config.LLM_MODEL || 'fixture' }, fence: null, updatedAt: new Date().toISOString() });
      });
    } catch (error) {
      await repo.change(candidate.id, job => {
        if (job.fence !== fence || job.status !== 'running') return;
        Object.assign(job, { status: controller.signal.aborted ? 'stale' : 'failed', error: error.code || 'workspace_analysis_failed', snapshot: [], preview: '', result: null, fence: null, updatedAt: new Date().toISOString() });
      });
    } finally { clearInterval(timer); }
    // One model request per cycle; the workspace lane never holds up audio work.
    return;
  }
}
