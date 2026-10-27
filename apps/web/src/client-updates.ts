export type UpdateStatus = { phase: string; currentVersion: string; version?: string | null; notes?: string | null; downloaded: number; total?: number | null; error?: string | null; installer?: boolean };
export type UpdatePreferences = { autoCheck: boolean; autoDownload: boolean; autoInstall: false };
export type UpdatePolicy = 'manual' | 'check' | 'background';
export type UpdateActivity = { authenticated: boolean; recording: boolean; paused: boolean; busy: boolean; queueBusy: boolean; pendingBytes: number; pendingCount: number };
export const defaultUpdatePreferences: UpdatePreferences = { autoCheck: true, autoDownload: false, autoInstall: false };
export function normalizeUpdatePreferences(value: unknown): UpdatePreferences {
  const saved = value && typeof value === 'object' ? value as Partial<UpdatePreferences> : {};
  const autoCheck = saved.autoCheck !== false;
  return { autoCheck, autoDownload: autoCheck && saved.autoDownload === true, autoInstall: false };
}
export function updatePolicy(preferences: UpdatePreferences): UpdatePolicy {
  return !preferences.autoCheck ? 'manual' : preferences.autoDownload ? 'background' : 'check';
}
export function preferencesForPolicy(policy: string): UpdatePreferences {
  return { autoCheck: policy !== 'manual', autoDownload: policy === 'background', autoInstall: false };
}
export function updateBlockReason(activity: UpdateActivity) {
  if (!activity.authenticated) return '请先登录，核对录音与补传状态后安装更新';
  if (activity.recording) return '正在录音，结束会议后才能安装更新';
  if (activity.paused) return '本场处于暂停状态，请结束会议后安装更新';
  if (activity.busy || activity.queueBusy) return '正在保存音频，请稍后安装更新';
  if (activity.pendingBytes > 0 || activity.pendingCount > 0) return '还有待传音频，补传完成后才能安装更新';
  return '';
}
type Dependencies = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  activity: () => Omit<UpdateActivity, 'queueBusy' | 'pendingBytes' | 'pendingCount'>;
  queue: () => Promise<{ queueBusy: boolean; pendingBytes: number; pendingCount: number }>;
  preferences: () => UpdatePreferences;
  preferencesChanged: (preferences: UpdatePreferences) => void;
  changed: (status: UpdateStatus) => void;
  freeze: (value: boolean) => void;
};
export class ClientUpdates {
  status: UpdateStatus = { phase: 'idle', currentVersion: '', downloaded: 0 };
  private dependencies: Dependencies;
  private operating = false; private nextCheck = 0; private nextDownload = 0;
  constructor(dependencies: Dependencies) { this.dependencies = dependencies; }
  apply(status: UpdateStatus) { this.status = status; this.dependencies.changed(status); }
  async initialize() { this.apply(await this.dependencies.invoke('update_status') as UpdateStatus); }
  private async request(command: string) {
    if (this.operating) return;
    this.operating = true;
    try { this.apply(await this.dependencies.invoke(command) as UpdateStatus); }
    catch (error) {
      const status = await this.dependencies.invoke('update_status').catch(() => this.status) as UpdateStatus;
      this.apply({ ...status, error: error instanceof Error ? error.message : String(error) });
    } finally { this.operating = false; }
  }
  async check() { if (this.status.phase !== 'disabled') await this.request('update_check'); }
  async preferencesChanged(now: number) { this.nextCheck = 0; this.nextDownload = 0; await this.tick(now); }
  async download() { if (this.status.phase === 'available') await this.request('update_download'); }
  async menuAction(action: string) {
    if (this.operating || this.status.phase === 'disabled' || ['checking', 'downloading', 'preparing', 'installing'].includes(this.status.phase)) return;
    if (action === 'status-update-check') {
      await this.check();
      if (this.dependencies.preferences().autoDownload && !this.status.error) await this.download();
    } else if (action === 'status-update-background') {
      this.dependencies.preferencesChanged(preferencesForPolicy(this.dependencies.preferences().autoDownload ? 'check' : 'background'));
      await this.activityChanged();
      if (this.dependencies.preferences().autoDownload && !this.status.error) await this.download();
    } else if (action === 'status-update-install') await this.install();
  }
  async install() {
    if (this.operating || this.status.phase !== 'ready') return;
    this.operating = true; this.dependencies.freeze(true);
    this.apply({ ...this.status, phase: 'preparing', error: null });
    try {
      const queue = await this.dependencies.queue();
      const activity = { ...this.dependencies.activity(), ...queue };
      const reason = updateBlockReason(activity); if (reason) throw new Error(reason);
      await this.dependencies.invoke('update_activity', { activity });
      // Native code independently checks active/pending capture, state age and the server stop/ACK barrier.
      await this.dependencies.invoke('update_install');
    } catch (error) {
      const status = await this.dependencies.invoke('update_status').catch(() => ({ ...this.status, phase: 'ready' })) as UpdateStatus;
      this.apply({ ...status, error: error instanceof Error ? error.message : String(error) });
    } finally { this.operating = false; this.dependencies.freeze(false); }
  }
  async activityChanged() {
    const queue = await this.dependencies.queue();
    const activity = { ...this.dependencies.activity(), ...queue };
    await this.dependencies.invoke('update_activity', { activity, autoDownload: this.dependencies.preferences().autoDownload });
    return updateBlockReason(activity);
  }
  async tick(now: number) {
    if (this.operating || this.status.phase === 'disabled') return;
    const preferences = this.dependencies.preferences();
    if (preferences.autoCheck && now >= this.nextCheck) {
      this.nextCheck = now + 6 * 60 * 60 * 1000; await this.check();
      if (this.status.error) this.nextCheck = now + 15 * 60 * 1000;
    }
    if (preferences.autoDownload && this.status.phase === 'available' && now >= this.nextDownload) {
      this.nextDownload = now + 15 * 60 * 1000;
      await this.download();
    }
  }
}
