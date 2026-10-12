import { useState } from 'react';
import { Pause, CheckCircle } from '@phosphor-icons/react';
import { Button, Modal } from './ui';

export function MeetingFinish({ title, paused, busy, error, pause, finish, close }: {
  title: string; paused: boolean; busy: boolean; error: string; pause: (title: string) => void; finish: (title: string) => void; close: () => void;
}) {
  const [name, setName] = useState(title === '未命名会议' ? '' : title);
  return <Modal title={paused ? '为本场会议收个尾' : '先暂停，还是就此收尾？'} onClose={() => { if (!busy) close(); }}>
    <p className="finish-intro">{paused ? '结束后会继续处理已保存的音频，并整理本场纪要。' : '暂停后可以接着聊；结束后，新对话会拥有自己的记录。'}</p>
    <form onSubmit={event => { event.preventDefault(); finish(name.trim()); }}>
      <label>给这场对话一个名字 <span className="muted">可稍后填写</span><input autoFocus aria-label="会议标题" value={name} onChange={event => setName(event.target.value)} maxLength={160} placeholder="例如：产品方向讨论" disabled={busy}/></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="finish-actions">{!paused && <Button type="button" disabled={busy} onClick={() => pause(name.trim())}><Pause size={17} weight="fill"/>暂停，稍后继续</Button>}<Button variant="primary" type="submit" disabled={busy}><CheckCircle size={18}/>{busy ? '正在保存…' : '结束本场会议'}</Button></div>
      <p className="fine-print">标题随时可改。结束不会丢弃待传音频，剩余片段会继续处理。</p>
    </form>
  </Modal>;
}
