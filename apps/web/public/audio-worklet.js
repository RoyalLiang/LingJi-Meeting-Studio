/* PCM16 capture: never encodes or uploads screen video. */
class MeetingPcm extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = []; this.phase = 0; this.sum = 0; this.count = 0; this.meterFrames = 0;
    this.port.onmessage = event => { if (event.data.type === 'flush') { this.flush(); this.port.postMessage({ type: 'flushed' }); } };
  }
  flush() {
    if (!this.samples.length) return;
    const buffer = new ArrayBuffer(this.samples.length * 2), view = new DataView(buffer);
    this.samples.forEach((v, i) => view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true));
    this.port.postMessage({ type: 'pcm', buffer }, [buffer]); this.samples = [];
  }
  process(inputs) {
    const channels = inputs[0]; if (!channels?.length) return true;
    let energy = 0;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i] / channels.length;
      energy += sample * sample; this.sum += sample; this.count++; this.phase += 16000;
      if (this.phase >= sampleRate) { this.samples.push(this.sum / this.count); this.phase -= sampleRate; this.sum = 0; this.count = 0; }
      if (this.samples.length >= 32000) this.flush();
    }
    if (++this.meterFrames % 32 === 0) this.port.postMessage({ type: 'meter', value: Math.sqrt(energy / channels[0].length) });
    return true;
  }
}
registerProcessor('meeting-pcm', MeetingPcm);
