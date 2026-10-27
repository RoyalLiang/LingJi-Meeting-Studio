export type PlaybackMedia = Pick<HTMLAudioElement, 'duration' | 'currentTime' | 'paused' | 'ended' | 'play' | 'pause' | 'error' | 'load' | 'playbackRate' | 'preservesPitch' | 'volume'> & Partial<Pick<HTMLAudioElement,'addEventListener'|'removeEventListener'|'preload'>> & {webkitPreservesPitch?: boolean};

const finiteDuration = (media: PlaybackMedia) => Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;

/** The longest saved source is the shared clock; shorter sources end naturally. */
export class PlaybackTransport {
  private generation = 0;
  private requested = false;
  private activeTracks: PlaybackMedia[] = [];
  private rate = 1;
  private loading: AbortController | null = null;
  private loadingPosition: number | undefined;

  constructor(private readonly tracks: () => PlaybackMedia[], private readonly savedDuration = 0, private readonly startsAt: (media: PlaybackMedia) => number = () => 0) {}

  get duration() {
    const durations = this.tracks().map(finiteDuration);
    return this.savedDuration > 0 ? Math.max(this.savedDuration, ...durations) : durations.every(duration => duration > 0) ? Math.max(0, ...durations) : 0;
  }
  get leader() {
    return this.tracks().reduce<PlaybackMedia | undefined>((longest, media) =>
      !longest || finiteDuration(media) > finiteDuration(longest) ? media : longest, undefined);
  }
  get time() { return this.loadingPosition ?? (this.leader?.currentTime || 0); }
  get playing() { return this.requested && this.tracks().some(media => !media.paused && !media.ended); }

  setRate(rate: number) {
    if (![0.75, 1, 1.25, 1.5, 2].includes(rate)) throw new RangeError('Unsupported playback rate');
    this.rate = rate;
    this.tracks().forEach(media => this.configure(media));
    this.syncLevels();
  }

  private configure(media: PlaybackMedia) {
    media.playbackRate = this.rate; media.preservesPitch = true;
    if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = true;
  }

  syncLevels() {
    const tracks = this.tracks();
    // Count overlapping sources, so sequential resumed clips keep their original level.
    const overlap = Math.max(1,...tracks.map(track => tracks.filter(media => this.startsAt(media) <= this.startsAt(track) && (!finiteDuration(media) || finiteDuration(media) > this.startsAt(track))).length));
    tracks.forEach(media => { if (media.volume !== 1 / overlap) media.volume = 1 / overlap; });
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
    this.loading?.abort(); this.loading = null;
    if (this.loadingPosition !== undefined) { const position = this.loadingPosition; this.loadingPosition = undefined; this.seek(position); }
    new Set([...this.tracks(), ...this.activeTracks]).forEach(media => media.pause());
  }

  private async metadata(media: PlaybackMedia, signal: AbortSignal, position: number) {
    if ((finiteDuration(media) && !media.error) || !media.addEventListener || !media.removeEventListener || signal.aborted) return;
    await new Promise<void>((resolve,reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer); media.removeEventListener!('loadedmetadata',ready); media.removeEventListener!('error',failed); signal.removeEventListener('abort',ready);
        if (error) reject(error); else resolve();
      };
      const ready = () => done(), failed = () => done(new Error('Audio metadata unavailable'));
      const timer = setTimeout(failed,15000);
      media.addEventListener!('loadedmetadata',ready,{once:true}); media.addEventListener!('error',failed,{once:true}); signal.addEventListener('abort',ready,{once:true});
      try { media.preload = 'metadata'; media.load(); media.currentTime = position; } catch (error) { done(error instanceof Error ? error : new Error('Audio metadata unavailable')); }
    });
  }

  async play() {
    const generation = ++this.generation;
    this.requested = true;
    this.loading?.abort();
    const loading = this.loading = new AbortController();
    const tracks = this.tracks();
    this.activeTracks = tracks;
    const position = this.time;
    this.loadingPosition = position;
    const pending = tracks.filter(media => (!finiteDuration(media) || media.error) && media.addEventListener && media.removeEventListener);
    try { if (pending.length) await Promise.all(pending.map(media => this.metadata(media,loading.signal,position))); }
    catch (error) { if (generation === this.generation) this.pause(); throw error; }
    if (generation !== this.generation) return;
    this.loading = null; this.loadingPosition = undefined;
    this.syncLevels();
    for (const media of tracks) if (Math.abs(media.currentTime - position) > .02) media.currentTime = Math.min(finiteDuration(media) || this.savedDuration || position, position);
    const results = await Promise.allSettled(tracks.filter(media => !finiteDuration(media) || media.currentTime < media.duration)
      .map(async media => {
        try {
          if (media.error) { media.load(); media.currentTime = Math.min(finiteDuration(media) || this.savedDuration || position,position); }
          // load() resets playbackRate to defaultPlaybackRate in browser media elements.
          this.configure(media);
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
      const duration = finiteDuration(media) || this.savedDuration;
      if (duration) media.currentTime = Math.min(duration, position);
    });
    return position;
  }
}

/** Interpolate the visible cursor; transport and seeks keep the actual media time. */
export class PlaybackClock {
  private sample = NaN;
  private anchor = 0;
  private started = 0;
  private shown = 0;
  private playing = false;
  private rate = 1;

  reset(time: number, now: number) {
    this.sample = this.anchor = this.shown = time;
    this.started = now;
  }

  read(time: number, now: number, playing: boolean, rate = 1) {
    if (!playing || !this.playing || !Number.isFinite(this.sample) || time < this.sample-.05 || time - this.sample > Math.max(1.5,rate*1.5) || rate !== this.rate) {
      this.reset(time, now);
    }
    this.playing = playing; this.rate = rate;
    // WebViews can report media time in one-second batches while audio keeps playing.
    const lead = 1.25 * Math.max(1,rate);
    let predicted = this.anchor + Math.max(0, now - this.started) / 1000 * rate;
    if (time !== this.sample && Math.abs(time - predicted) > lead) {
      this.reset(time, now); predicted = time;
    }
    this.sample = time;
    this.shown = playing ? Math.max(this.shown, Math.min(predicted, time + lead)) : time;
    return this.shown;
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
