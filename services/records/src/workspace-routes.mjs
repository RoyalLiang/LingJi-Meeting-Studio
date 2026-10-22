import { createWorkspace, workspaceFields, retainedRecords, virtualScopes, workspaceOverview, analysisId, requestWorkspaceAnalysis, publicWorkspaceAnalysis } from '../../../packages/records/src/workspaces.mjs';
import { requireThat, emit } from '../../../packages/records/src/record.mjs';
import { providerStatus } from './providers.mjs';
import { readConfig } from './config.mjs';

export async function requireWorkspace(repo, owner, scope) {
  if (virtualScopes.includes(scope)) return { id: scope, name: scope === 'all' ? '所有会议' : '未归档', description: scope === 'all' ? '让每一次讨论，成为下一步的起点。' : '这些会议还没有放入工作目录。' };
  requireThat(typeof scope === 'string' && /^[a-f0-9-]{36}$/.test(scope), 'workspace_not_found', 404);
  const workspace = await repo.get(scope);
  requireThat(workspace?.kind === 'workspace' && workspace.owner === owner, 'workspace_not_found', 404);
  return workspace;
}
export async function workspaceRoutes({ req, res, path, repo, user, readBody, send }) {
  if (!path.startsWith('/api/workspaces')) return false;
  if (path === '/api/workspaces') {
    if (req.method === 'GET') {
      const workspaces = (await repo.list('workspace')).filter(w => w.owner === user.id).map(({ id, name, description, createdAt, updatedAt }) => ({ id, name, description, createdAt, updatedAt }));
      send(res, 200, { workspaces }); return true;
    }
    if (req.method === 'POST') {
      requireThat((await repo.list('workspace')).filter(w => w.owner === user.id).length < 50, 'workspace_limit', 429);
      send(res, 201, await repo.insert(createWorkspace(user.id, await readBody(req, 4000)))); return true;
    }
  }
  if (path === '/api/workspaces/archive' && req.method === 'POST') {
    const body = await readBody(req, 16000), ids = body.recordIds;
    requireThat(Array.isArray(ids) && ids.length > 0 && ids.length <= 200 && ids.every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)), 'invalid_record_selection', 400);
    const destination = body.workspaceId || 'inbox';
    requireThat(destination !== 'all', 'invalid_workspace', 400); await requireWorkspace(repo, user.id, destination);
    await repo.changeMany(ids, records => {
      for (const r of records) {
        requireThat(r.kind === 'record' && r.owner === user.id && !r.deleted && Date.parse(r.deleteAt) > Date.now(), 'record_not_found', 404);
        requireThat(r.capture !== 'recording', 'archive_recording', 409);
      }
      for (const r of records) { r.workspaceId = destination === 'inbox' ? null : destination; emit(r, 'record.archived', { workspaceId: r.workspaceId }); }
    });
    send(res, 200, { archived: [...new Set(ids)].length, workspaceId: destination === 'inbox' ? null : destination }); return true;
  }
  const route = path.match(/^\/api\/workspaces\/(all|inbox|[a-f0-9-]{36})(?:\/(overview|analysis|analysis\/cancel))?$/);
  requireThat(route, 'not_found', 404);
  const scope = route[1], action = route[2] || '', workspace = await requireWorkspace(repo, user.id, scope);
  if (!action && req.method === 'PATCH') {
    requireThat(!virtualScopes.includes(scope), 'invalid_workspace', 400);
    const fields = workspaceFields(await readBody(req, 4000));
    send(res, 200, await repo.change(scope, w => { requireThat(w.owner === user.id && w.kind === 'workspace', 'workspace_not_found', 404); Object.assign(w, fields, { updatedAt: new Date().toISOString() }); })); return true;
  }
  const records = retainedRecords(await repo.list(), user.id, scope), jobId = analysisId(user.id, scope), job = await repo.get(jobId);
  if (action === 'overview' && req.method === 'GET') {
    send(res, 200, { workspace: { id: workspace.id, name: workspace.name, description: workspace.description }, ...workspaceOverview(records), analysis: publicWorkspaceAnalysis(job, records) }); return true;
  }
  if (action === 'analysis' && req.method === 'POST') {
    requireThat(providerStatus(await readConfig(repo.root)).textMinutes, 'minutes_not_configured', 503);
    const next = requestWorkspaceAnalysis(user.id, scope, records, job);
    if (next === job) { send(res, 202, publicWorkspaceAnalysis(job, records)); return true; }
    if (!job) await repo.insert(next);
    else await repo.change(jobId, value => { Object.assign(value, next); delete value.fence; delete value.lease; delete value.error; delete value.runtime; });
    send(res, 202, publicWorkspaceAnalysis(next, records)); return true;
  }
  if (action === 'analysis/cancel' && req.method === 'POST') {
    const body = await readBody(req, 1000);
    if (job) await repo.change(jobId, value => {
      requireThat(value.runId === body.runId, 'analysis_run_conflict', 409);
      if (['queued', 'running'].includes(value.status)) Object.assign(value, { status: 'cancelled', fence: null, snapshot: [], preview: '', updatedAt: new Date().toISOString() });
    });
    send(res, 200, { cancelled: true }); return true;
  }
  requireThat(false, 'not_found', 404);
}
