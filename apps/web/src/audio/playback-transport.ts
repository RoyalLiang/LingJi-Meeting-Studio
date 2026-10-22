export type PlaybackMedia = Pick<HTMLAudioElement, 'duration' | 'currentTime' | 'paused' | 'ended' | 'play' | 'pause' | 'error' | 'load' | 'playbackRate' | 'preservesPitch'>;

const finiteDuration = (media: PlaybackMedia) => Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;

/** The longest saved source is the shared clock; shorter sources end naturally. */
export class PlaybackTransport {
  private generation = 0;
  private requested = false;
  private activeTracks: PlaybackMedia[] = [];
  private rate = 1;

  constructor(private readonly tracks: () => PlaybackMedia[]) {}

  get duration() {
    const durations = this.tracks().map(finiteDuration);
    return durations.every(duration => duration > 0) ? Math.max(0, ...durations) : 0;
  }
  get time() {
    const leader = this.tracks().reduce<PlaybackMedia | undefined>((longest, media) =>
      !longest || finiteDuration(media) > finiteDuration(longest) ? media : longest, undefined);
    return leader?.currentTime || 0;
  }
  get playing() { return this.requested && this.tracks().some(media => !media.paused && !media.ended); }

  setRate(rate: number) {
    if (![0.75, 1, 1.25, 1.5, 2].includes(rate)) throw new RangeError('Unsupported playback rate');
    this.rate = rate;
    this.tracks().forEach(media => { media.playbackRate = rate; media.preservesPitch = true; });
  }

  async skip(delta: number) {
    if (!this.duration || !Number.isFinite(delta)) return this.time;
    const resume = this.playing;
    const position = this.time + delta;
    this.pause();
    this.seek(position);
    if (resume && this.time < this.duration) await this.play();
    return this.time;
  }

  pause() {
    this.generation++;
    this.requested = false;
    new Set([...this.tracks(), ...this.activeTracks]).forEach(media => media.pause());
  }

  async play() {
    const generation = ++this.generation;
    this.requested = true;
    const tracks = this.tracks();
    this.activeTracks = tracks;
    const results = await Promise.allSettled(tracks.filter(media => !finiteDuration(media) || media.currentTime < media.duration)
      .map(async media => {
        try {
          if (media.error) media.load();
          // load() resets playbackRate to defaultPlaybackRate in browser media elements.
          media.playbackRate = this.rate; media.preservesPitch = true;
          await media.play();
        }
        catch (error) { if (generation === this.generation) this.pause(); throw error; }
      }));
    // A reset or pause must also cancel a play() that was still loading.
    if (generation !== this.generation && !this.requested) tracks.forEach(media => media.pause());
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (generation === this.generation) {
      const time = this.time;
      this.tracks().forEach(media => {
        if (finiteDuration(media) && !media.ended && Math.abs(media.currentTime - time) > .2) media.currentTime = Math.min(media.duration, time);
      });
    }
  }

  seek(time: number) {
    if (!this.duration || !Number.isFinite(time)) return this.time;
    const position = Math.max(0, Math.min(this.duration, time));
    this.tracks().forEach(media => {
      const duration = finiteDuration(media);
      if (duration) media.currentTime = Math.min(duration, position);
    });
    return position;
  }
}

/** Pointer movement previews a position without repeatedly seeking the media. */
export class PlaybackScrub {
  private resume = false;
  private position = 0;
  active = false;

  constructor(private readonly transport: PlaybackTransport, private readonly preview: (time: number) => void) {}

  begin() {
    if (this.active || !this.transport.duration) return;
    this.resume = this.transport.playing;
    this.position = this.transport.time;
    this.active = true;
    this.transport.pause();
  }

  move(time: number) {
    if (!this.active) return;
    this.position = Math.max(0, Math.min(this.transport.duration, time));
    this.preview(this.position);
  }

  finish(commit = true, allowResume = true) {
    if (!this.active) return false;
    this.active = false;
    this.preview(commit ? this.transport.seek(this.position) : this.transport.time);
    const resume = this.resume && allowResume && this.transport.time < this.transport.duration;
    this.resume = false;
    return resume;
  }
}
