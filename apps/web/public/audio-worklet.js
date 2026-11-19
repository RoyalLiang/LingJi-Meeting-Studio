/* PCM16 capture: never encodes or uploads screen video. */
class MeetingPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capturing = true;
    this.packet = new DataView(new ArrayBuffer(6400 * 2));
    this.used = 0;
    this.packetEnergy = 0;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.meterFrames = 0;
    this.port.onmessage = event => { if (event.data.type === 'flush' || event.data.type === 'pause') {
        if (event.data.type === 'pause') this.capturing = false;
        this.flush(); this.port.postMessage({ type: 'flushed' });
      } };
  }
  flush() {
    if (!this.used) return;
    const full = this.used === this.packet.byteLength;
    const buffer = full ? this.packet.buffer : this.packet.buffer.slice(0, this.used);
    const rms = Math.sqrt(this.packetEnergy / (this.used / 2));
    this.port.postMessage({ type: 'pcm', buffer, rms }, [buffer]);
    this.packet = new DataView(new ArrayBuffer(16000 * 2));
    this.used = 0;
    this.packetEnergy = 0;
  }
  process(inputs) {
    if (!this.capturing) return true;
    const channels = inputs[0]; if (!channels?.length) return true;
    let energy = 0;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i] / channels.length;
      energy += sample * sample; this.sum += sample; this.count++; this.phase += 16000;
      if (this.phase >= sampleRate) {
        const sample = Math.round(Math.max(-1, Math.min(1, this.sum / this.count)) * 32767);
        this.packet.setInt16(this.used, sample, true);
        this.packetEnergy += (sample / 32768) ** 2;
        this.used += 2;
        this.phase -= sampleRate;
        this.sum = 0;
        this.count = 0;
        if (this.used === this.packet.byteLength) this.flush();
      }
    }
    if (++this.meterFrames % 32 === 0) this.port.postMessage({ type: 'meter', value: Math.sqrt(energy / channels[0].length) });
    return true;
  }
}
registerProcessor('meeting-pcm', MeetingPcm);
