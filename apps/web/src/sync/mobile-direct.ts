// Developer preview: two foreground peers, one recording, and one reconnection per code.
import { api, ApiError } from '../api';
import { heldAudio, openLiveAudio, releaseHeldAudio } from './mobile';
import { createMobileAudioReceiver } from './mobile-desktop';
import { newPairSecret, seal, unseal, type EncryptedOperation, type Vault } from './vault';

type Room = { id: string; proof: string };
type PairState = { frames: string[]; expires: number };
type Packet = { v2: boolean; operation: EncryptedOperation };
type Receipt = { next: number; done: boolean; window?: number };
type Progress = (message: string) => void;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const purpose = 'mobile-direct/sdp/1';
const messageLimit = 60_000;
const transferWindow = 8;
const signalLimit = 24_000;
function linkedSignal(signals: AbortSignal[], ms?: number) {
  if (typeof AbortSignal.any === 'function' && (ms === undefined || typeof AbortSignal.timeout === 'function')) {
    return AbortSignal.any(ms === undefined ? signals : [...signals, AbortSignal.timeout(ms)]);
  }
  const aborted = signals.find(signal => signal.aborted);
  if (aborted) return aborted;
  const controller = new AbortController();
  const aborts = signals.map(signal => {
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    return abort;
  });
  const timer = ms === undefined ? undefined : setTimeout(() => {
    controller.abort(new DOMException('直传连接超时', 'TimeoutError'));
  }, ms);
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timer);
    signals.forEach((signal, index) => signal.removeEventListener('abort', aborts[index]));
  }, { once: true });
  return controller.signal;
}
const timeout = (signal: AbortSignal, ms: number) => linkedSignal([signal], ms);

export class DirectUnavailableError extends Error {}

function pending<T>(source: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    source.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function roomId(vault: Vault, root: Uint8Array<ArrayBuffer>, code: string) {
  if (!/^\d{8}$/.test(code)) throw new Error('请输入 8 位接收码');
  const key = await crypto.subtle.importKey('raw', root, {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const hash = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify([purpose, vault.id, code]))));
  hash[6] = (hash[6] & 15) | 64;
  hash[8] = (hash[8] & 63) | 128;
  const id = [...hash.subarray(0, 16)].map(value => value.toString(16).padStart(2, '0')).join('');
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
}

export async function createDirectRoom(vault: Vault, root: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 100_000_000).padStart(8, '0');
  const room = { id: await roomId(vault, root, code), proof: newPairSecret() };
  await api('/private-sync/pair/start', 'POST', { ...room, direct: true }, timeout(signal, 8000));
  return { room, code };
}

function exchange(room: Room, signal: AbortSignal, frame?: { step: number; data: string }) {
  return api<PairState>('/private-sync/pair/exchange', 'POST', { ...room, frame }, timeout(signal, 6500));
}

async function postSdp(room: Room, vault: Vault, root: Uint8Array<ArrayBuffer>, step: number, sdp: string, signal: AbortSignal) {
  const encrypted = await seal(root, vault, purpose, room.id + ':' + step, encoder.encode(sdp));
  const data = encrypted.nonce + encrypted.body;
  if (data.length > signalLimit) throw new Error('网络候选过多，无法建立直传');
  // A retry sends the identical encrypted frame so the relay can deduplicate it.
  try { await exchange(room, signal, { step, data }); }
  catch (failure) {
    signal.throwIfAborted();
    if (!(failure instanceof ApiError) || failure.status !== 0) throw failure;
    await exchange(room, signal, { step, data });
  }
}

async function waitSdp(room: Room, vault: Vault, root: Uint8Array<ArrayBuffer>, step: number, signal: AbortSignal) {
  for (;;) {
    try {
      const {frames} = await exchange(room, signal);
      const data = frames[step - 1];
      if (data) {
        const bytes = await unseal(root, vault, purpose, room.id + ':' + step, {nonce: data.slice(0, 16), body: data.slice(16)});
        try { return decoder.decode(bytes); }
        finally { bytes.fill(0); }
      }
    } catch (failure) {
      if (!(failure instanceof ApiError) || failure.status !== 0) throw failure;
    }
    await pending(new Promise(resolve => setTimeout(resolve, 1250)), signal);
  }
}

export function withLanCandidates(sdp: string, addresses: string[]) {
  const local = addresses.filter(address => {
    const octets = address.split('.');
    const [first, second] = octets.map(Number);
    return octets.length === 4 && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
      && (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168));
  }).slice(0, 2);
  return sdp.replace(/^a=candidate:[^\r\n]+/gm, line => {
    const parts = line.split(' ');
    if (parts[2]?.toLowerCase() !== 'udp' || !parts[4]?.endsWith('.local') || parts[7] !== 'host') return line;
    return [line, ...local.map(address => [...parts.slice(0, 4), address, ...parts.slice(5)].join(' '))].join('\r\n');
  });
}

async function phoneAddresses(signal: AbortSignal): Promise<string[]> {
  return new Promise(resolve => {
    const result = (event: Event) => {
      try {
        const addresses: unknown = JSON.parse((event as CustomEvent<string>).detail);
        finish(Array.isArray(addresses) ? addresses.filter(value => typeof value === 'string') : []);
      } catch { finish([]); }
    };
    const abort = () => finish([]);
    const timer = setTimeout(abort, 500);
    function finish(addresses: string[]) {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      removeEventListener('lingji:direct-addresses', result);
      resolve(addresses);
    }
    signal.addEventListener('abort', abort, { once: true });
    addEventListener('lingji:direct-addresses', result, { once: true });
    dispatchEvent(new Event('lingji:request-direct-addresses'));
  });
}

async function gather(peer: RTCPeerConnection, description: RTCSessionDescriptionInit, signal: AbortSignal, addresses: Promise<string[]>) {
  await pending(peer.setLocalDescription(description), signal);
  const usesIceServers = Boolean(peer.getConfiguration().iceServers?.length);
  if (peer.iceGatheringState !== 'complete') {
    const gathered = new Promise<void>(resolve => {
      const check = () => { if (peer.iceGatheringState === 'complete') resolve(); };
      peer.onicegatheringstatechange = check;
      check();
    });
    try { await pending(gathered, timeout(signal, usesIceServers ? 4500 : 2000)); }
    catch { signal.throwIfAborted(); }
    finally { peer.onicegatheringstatechange = null; }
  }
  const sdp = peer.localDescription?.sdp;
  if (!sdp?.includes('a=candidate:')) throw new DirectUnavailableError('当前网络没有可用的直连地址');
  const expanded = withLanCandidates(sdp, await addresses);
  return encoder.encode(expanded).byteLength <= (usesIceServers ? 17_970 : 4450) ? expanded : sdp;
}

function pipe(channel: RTCDataChannel, signal: AbortSignal) {
  let partial = '';
  const input = new ReadableStream<string>({
    start(controller) {
      channel.onmessage = ({data}) => {
        if (typeof data !== 'string' || data.length > 12_001 || !/^[01]/.test(data)
          || partial.length + data.length - 1 > messageLimit || controller.desiredSize! <= 0) {
          channel.close();
          return;
        }
        partial += data.slice(1);
        if (data[0] === '1') { controller.enqueue(partial); partial = ''; }
      };
      channel.onclose = () => controller.error(new Error('直传通道已断开'));
      channel.onerror = () => channel.close();
    },
  }, { highWaterMark: transferWindow }).getReader();
  return {
    async ready() {
      if (channel.readyState === 'open') return;
      if (channel.readyState !== 'connecting') throw new Error('直传通道已断开');
      const opened = new Promise<void>((resolve, reject) => {
        channel.addEventListener('open', () => resolve(), { once: true });
        channel.addEventListener('close', () => reject(new Error('直传通道已断开')), { once: true });
      });
      await pending(opened, timeout(signal, 10_000));
    },
    send(value: unknown) {
      signal.throwIfAborted();
      const data = JSON.stringify(value);
      if (data.length > messageLimit) throw new Error('直传片段超过容量');
      // At most one audio packet can be outstanding. Each SCTP message stays under 16 KiB.
      for (let start = 0; start < data.length; start += 12_000) {
        channel.send((start + 12_000 >= data.length ? '1' : '0') + data.slice(start, start + 12_000));
      }
    },
    async read<T>(ms = 15_000) {
      const { value, done } = await pending(input.read(), timeout(signal, ms));
      if (done || value === undefined) throw new Error('直传通道已断开');
      return JSON.parse(value) as T;
    },
  };
}

async function connect(room: Room, signal: AbortSignal) {
  const { iceServers } = await api<{ iceServers: RTCIceServer[] }>('/private-sync/direct/ice', 'POST', room, timeout(signal, 5000))
    .catch(failure => {
      signal.throwIfAborted();
      if (failure instanceof ApiError && (failure.status === 0 || failure.code === 'not_found')) return { iceServers: [] };
      throw failure;
    });
  signal.throwIfAborted();
  const peer = new RTCPeerConnection({ iceServers });
  const stopped = new AbortController();
  const networkChanged = () => stopped.abort(new Error('网络已切换'));
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'failed') stopped.abort(new DirectUnavailableError('无法建立直传连接'));
    if (peer.connectionState === 'closed') stopped.abort(new Error('直传通道已断开'));
  };
  return {
    peer, signal: linkedSignal([signal, stopped.signal]),
    watchNetwork() { addEventListener('lingji:network-changed', networkChanged); },
    close() {
      removeEventListener('lingji:network-changed', networkChanged);
      stopped.abort();
      peer.close();
    },
  };
}

async function connectionLabel(peer: RTCPeerConnection, signal: AbortSignal) {
  try {
    const stats = await pending(peer.getStats(), timeout(signal, 1000));
    const reports = [...stats.values()];
    const transport = reports.find(report => report.type === 'transport' && report.selectedCandidatePairId);
    const pair = transport ? stats.get(transport.selectedCandidatePairId)
      : reports.find(report => report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded');
    if (!pair) return '';
    const candidates = [stats.get(pair.localCandidateId), stats.get(pair.remoteCandidateId)];
    if (candidates.some(candidate => candidate?.candidateType === 'relay')) return '（TURN 中继）';
    const addresses = candidates.map(candidate => candidate?.address || candidate?.ip || '');
    if (addresses.some(address => address.includes(':'))) return '（IPv6 直连）';
    if (addresses.some(address => /^\d+\.\d+\.\d+\.\d+$/.test(address))) return '（IPv4 直连）';
  } catch { /* path details depend on WebView stats support */ }
  return '';
}

function watchRoom(room: Room, signal: AbortSignal) {
  signal.throwIfAborted();
  const revoked = new AbortController();
  const active = linkedSignal([signal, revoked.signal]);
  const timer = setInterval(() => {
    void exchange(room, active).catch(failure => {
      if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) revoked.abort(failure);
    });
  }, 9000);
  active.addEventListener('abort', () => clearInterval(timer), { once: true });
  return active;
}

export async function receiveDirectAudio(vault: Vault, root: Uint8Array<ArrayBuffer>, room: Room, signal: AbortSignal, progress: Progress) {
  const invite = timeout(signal, 5 * 60_000);
  let id: string | undefined;
  for (const step of [1, 3]) {
    const offer = await waitSdp(room, vault, root, step, step === 1 ? invite : timeout(signal, 30_000));
    const link = await connect(room, signal);
    const { peer } = link;
    try {
      const channel = new Promise<RTCDataChannel>(resolve => { peer.ondatachannel = event => resolve(event.channel); });
      await pending(peer.setRemoteDescription({type:'offer', sdp:offer}), link.signal);
      const addresses = api<{ addresses: string[] }>('/private-sync/direct-addresses', 'GET', undefined, timeout(link.signal, 1500))
        .then(response => Array.isArray(response.addresses) ? response.addresses.filter(address => typeof address === 'string') : []).catch(() => []);
      const answer = await gather(peer, await pending(peer.createAnswer(), link.signal), link.signal, addresses);
      await postSdp(room, vault, root, step + 1, answer, link.signal);
      const active = watchRoom(room, link.signal);
      const wire = pipe(await pending(channel, timeout(active, 15_000)), active);
      await wire.ready();
      link.watchNetwork();
      const route = await connectionLabel(peer, active);
      const receive = createMobileAudioReceiver(vault, active);
      for (;;) {
        const packet = await wire.read<Packet>();
        if (typeof packet?.v2 !== 'boolean' || typeof packet.operation?.id !== 'string'
          || typeof packet.operation.nonce !== 'string' || typeof packet.operation.body !== 'string') throw new Error('直传数据无效');
        const frame = await openLiveAudio(vault, root, packet.operation, packet.v2);
        try {
          if (frame.kind === 'received' || (id ? frame.id !== id : frame.kind !== 'pcm' || frame.sequence !== 0)) {
            throw new Error('直传录音标识无效');
          }
          id = frame.id;
          const receipt = await receive(frame);
          if (receipt === 'deleted') throw new Error('桌面已删除该录音');
        if (!receipt) throw new Error('桌面缺少录音开头，等待加密同步补齐');
          wire.send({ ...receipt, window: transferWindow });
          if (receipt.done) {
            progress('传输完成，录音已保存' + route);
            try { await wire.read<string>(2500); } catch { /* The recording is already saved. */ }
            return;
          }
          progress(`已保存 ${receipt.next} 个录音片段`);
        } finally {
          if (frame.kind === 'pcm') frame.pcm.bytes.fill(0);
        }
      }
    } catch (failure) {
      signal.throwIfAborted();
      if (step === 3) throw failure;
      progress('连接中断，等待手机续传');
    } finally {
      link.close();
    }
  }
}

export async function sendDirectAudio(vault: Vault, root: Uint8Array<ArrayBuffer>, id: string, code: string, signal: AbortSignal, progress: Progress) {
  const room = {id: await roomId(vault, root, code), proof: newPairSecret()};
  let next = 0;
  for (const step of [1, 3]) {
    const link = await connect(room, signal);
    const { peer } = link;
    let answered = false;
    try {
      const wire = pipe(peer.createDataChannel('lingji-audio'), link.signal);
      const offer = await gather(peer, await pending(peer.createOffer(), link.signal), link.signal, phoneAddresses(link.signal));
      await postSdp(room, vault, root, step, offer, link.signal);
      const answer = await waitSdp(room, vault, root, step + 1, timeout(link.signal, step === 1 ? 16_000 : 30_000));
      answered = true;
      await pending(peer.setRemoteDescription({type:'answer', sdp:answer}), link.signal);
      await wire.ready();
      link.watchNetwork();
      const authorized = watchRoom(room, link.signal);
      const route = await connectionLabel(peer, authorized);
      let window = 1;
      for (;;) {
        authorized.throwIfAborted();
        const first = next;
        const batch: Packet[] = [];
        for (let i = 0; i < window; i++) {
          const packet = await heldAudio(vault, id, first + i);
          if (!packet) break;
          wire.send(packet);
          batch.push(packet);
        }
        if (!batch.length) throw new Error('本机直传队列缺少录音片段');
        for (const [index, packet] of batch.entries()) {
          const receipt = await pending(wire.read<Receipt>(), authorized);
          const sequence = first + index;
          if (typeof receipt?.done !== 'boolean' || !Number.isSafeInteger(receipt.next) || receipt.next < next ||
              receipt.next > 200_000 || (!receipt.done && receipt.next <= sequence)) throw new Error('直传回执无效');
          if (receipt.done) {
            const final = await openLiveAudio(vault, root, packet.operation, packet.v2);
            if (final.kind === 'pcm') final.pcm.bytes.fill(0);
            if (final.kind !== 'finish' || receipt.next !== sequence) throw new Error('桌面结束回执不连续');
            await releaseHeldAudio(vault, id, false);
            try { wire.send('received'); await wire.read<string>(2500); } catch { /* The durable receipt is already validated. */ }
            progress('传输完成，Mac 已保存录音' + route);
            return;
          }
          next = receipt.next;
          if (receipt.window === transferWindow) window = transferWindow;
        }
        progress(`Mac 已保存 ${next} 个录音片段` + route);
      }
    } catch (failure) {
      signal.throwIfAborted();
      if (!answered || step === 3) throw failure;
      progress(`正在重新连接，将从第 ${next + 1} 个片段续传`);
    } finally {
      link.close();
    }
  }
}
