import { useEffect, useRef, useState, type RefObject } from 'react';
import { createDirectRoom, DirectUnavailableError, receiveDirectAudio, sendDirectAudio } from '../sync/mobile-direct';
import { heldAudio, releaseHeldAudio } from '../sync/mobile';
import type { Vault } from '../sync/vault';
import type { MobileRecording } from '../sync/mobile-library';
import { ApiError, messageOf } from '../api';
import { MobileSheet } from './MobileSheet';
import { Button } from './ui';

type Account = { vault: Vault; secret: RefObject<Uint8Array<ArrayBuffer> | null> };

export function MobileDirectSend({ vault, secret, entry, online }: Account & { entry: MobileRecording; online: boolean }) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const job = useRef<AbortController | null>(null);
  useEffect(() => {
    let mounted = true;
    void heldAudio(vault, entry.id, 0).then(value => { if (mounted) setAvailable(Boolean(value)); }).catch(() => {});
    return () => { mounted = false; job.current?.abort(); };
  }, [vault, entry.id]);

  async function send(direct: boolean) {
    if (job.current || !secret.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    const root = secret.current.slice();
    job.current = controller;
    setBusy(true);
    setNotice(direct ? '正在连接电脑…' : '正在排入加密同步队列…');
    try {
      if (direct) {
        try {
          await sendDirectAudio(vault, root, entry.id, code.trim(), signal, setNotice);
          if (!signal.aborted) setAvailable(false);
          return;
        } catch (failure) {
          signal.throwIfAborted();
          const unavailable = failure instanceof ApiError && failure.code === 'sync_pair_unavailable';
          const timedOut = failure instanceof DOMException && failure.name === 'TimeoutError';
          if (!unavailable && !timedOut && !(failure instanceof DirectUnavailableError)) throw failure;
        }
      }
      await releaseHeldAudio(vault, entry.id, true);
      dispatchEvent(new Event('lingji:live-audio-ready'));
      if (!signal.aborted) {
        setAvailable(false);
        setNotice(direct ? '直传未连通，已排入加密同步队列' : '已排入加密同步队列');
      }
    } catch (failure) {
      if (!signal.aborted) setNotice(messageOf(failure));
    } finally {
      root.fill(0);
      if (job.current === controller) job.current = null;
      if (!signal.aborted) setBusy(false);
    }
  }

  function close() {
    job.current?.abort();
    job.current = null;
    setOpen(false);
    setBusy(false);
    setNotice('');
  }

  return <>
    {available && <Button className="mobile-direct-button" onClick={() => setOpen(true)}>发送到电脑</Button>}
    {open && <MobileSheet title="发送到电脑" close={close}>
      {available && <form className="sync-form" onSubmit={event => { event.preventDefault(); void send(true); }}>
        <p>在电脑个人中心的「会议同步」获取接收码。连不上时将改用加密同步。</p>
        <label>8 位接收码<input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" maxLength={8} pattern="[0-9]{8}" required autoComplete="off" disabled={busy}/></label>
        <div className="mobile-sheet-actions">
          <Button type="submit" variant="primary" disabled={!online || busy || !/^\d{8}$/.test(code)}>开始直传</Button>
          <Button type="button" disabled={busy} onClick={() => void send(false)}>用加密同步发送</Button>
        </div>
      </form>}
      {notice && <p role="status">{notice}</p>}
    </MobileSheet>}
  </>;
}

export function MobileDirectReceive({ vault, secret, imported, online }: Account & { imported: () => void; online: boolean }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const job = useRef<AbortController | null>(null);
  useEffect(() => () => job.current?.abort(), []);

  async function start() {
    if (job.current || !secret.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    const root = secret.current.slice();
    job.current = controller;
    setBusy(true);
    setNotice('正在生成接收码…');
    try {
      if (typeof RTCPeerConnection !== 'function') throw new Error('当前环境不支持录音直传');
      const invite = await createDirectRoom(vault, root, signal);
      signal.throwIfAborted();
      setCode(invite.code);
      setNotice('在 Android 的录音详情输入接收码，保持两端应用运行。');
      await receiveDirectAudio(vault, root, invite.room, signal, setNotice);
      if (!signal.aborted) {
        imported();
      }
    } catch (failure) {
      if (!signal.aborted) setNotice(messageOf(failure));
    } finally {
      root.fill(0);
      if (job.current === controller) job.current = null;
      if (!signal.aborted) { setCode(''); setBusy(false); }
    }
  }

  return <div className="account-direct">
    <div className="sync-actions">
      {busy ? <Button type="button" onClick={() => {
        job.current?.abort();
        job.current = null;
        setBusy(false);
        setCode('');
        setNotice('');
      }}>停止接收</Button> : <Button type="button" disabled={!online} onClick={() => void start()}>接收手机直传</Button>}
      {code && <output aria-label="直传接收码"><strong>{code}</strong></output>}
    </div>
    {notice && <p role="status">{notice}</p>}
  </div>;
}
