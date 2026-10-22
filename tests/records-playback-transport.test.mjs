import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../apps/web/src/audio/playback-transport.ts', import.meta.url), 'utf8');
const outputText = stripTypeScriptTypes(source, { mode: 'transform' });
const { PlaybackTransport, PlaybackScrub } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function track(duration) {
  let currentTime = 0;
  return {
    duration, paused: true, seeks: [], starts: 0, playbackRate: 1, preservesPitch: true,
    get ended() { return currentTime >= duration; },
    get currentTime() { return currentTime; },
    set currentTime(time) { currentTime = time; this.seeks.push(time); },
    async play() { this.paused = false; this.starts++; },
    pause() { this.paused = true; },
  };
}

test('15 second jumps clamp to the timeline and keep paused recordings paused', async () => {
  const mic = track(90), meeting = track(60), transport = new PlaybackTransport(() => [mic, meeting]);
  await transport.skip(-15);
  assert.equal(transport.time, 0);
  transport.seek(50);
  await transport.skip(15);
  assert.equal(mic.currentTime, 65);
  assert.equal(meeting.currentTime, 60);
  assert.equal(mic.starts, 0);
  await transport.skip(100);
  assert.equal(transport.time, 90);
  await transport.skip(-100);
  assert.equal(transport.time, 0);
});

test('jumping backwards resumes an ended shorter track alongside a playing longer track', async () => {
  const mic = track(90), meeting = track(60), transport = new PlaybackTransport(() => [mic, meeting]);
  transport.seek(70);
  await transport.play();
  assert.equal(meeting.starts, 0);
  await transport.skip(-15);
  assert.equal(mic.currentTime, 55);
  assert.equal(meeting.currentTime, 55);
  assert.equal(mic.paused, false);
  assert.equal(meeting.paused, false);
  await transport.skip(100);
  assert.equal(transport.time, 90);
  assert.equal(transport.playing, false);
});

test('rate changes preserve pitch and apply to both tracks including a replacement', async () => {
  const mic = track(90), meeting = track(60);
  let tracks = [mic, meeting];
  const transport = new PlaybackTransport(() => tracks);
  transport.setRate(1.5);
  for (const media of tracks) {
    assert.equal(media.playbackRate, 1.5);
    assert.equal(media.preservesPitch, true);
  }
  const replacement = track(100); tracks = [replacement];
  await transport.play();
  assert.equal(replacement.playbackRate, 1.5);
  assert.throws(() => transport.setRate(NaN), /rate/);
  assert.throws(() => transport.setRate(0), /rate/);
  assert.equal(replacement.playbackRate, 1.5);
});

test('jumping before metadata is ready never writes an invalid seek position', async () => {
  const mic = track(90), meeting = track(NaN), transport = new PlaybackTransport(() => [mic, meeting]);
  await transport.skip(15);
  assert.deepEqual(mic.seeks, []);
  assert.deepEqual(meeting.seeks, []);
});

test('pause cancels a pending jump resume and a seek rejects non-finite positions', async () => {
  const media = track(90), transport = new PlaybackTransport(() => [media]);
  await transport.play();
  transport.seek(20);
  let release;
  media.play = () => new Promise(resolve => { release = () => { media.paused = false; resolve(); }; });
  const jumping = transport.skip(15);
  transport.pause();
  release();
  await jumping;
  assert.equal(media.currentTime, 35);
  assert.equal(media.paused, true);
  assert.equal(transport.playing, false);
  const before = media.seeks.length;
  transport.seek(NaN); transport.seek(Infinity);
  assert.equal(media.seeks.length, before);
});

test('one transport plays, pauses and seeks both saved sources on the longest timeline', async () => {
  const mic = track(1861), meeting = track(1860), transport = new PlaybackTransport(() => [mic, meeting]);
  assert.equal(transport.duration, 1861);
  await transport.play();
  assert.equal(mic.paused, false);
  assert.equal(meeting.paused, false);
  transport.pause();
  assert.equal(mic.paused, true);
  assert.equal(meeting.paused, true);
  transport.seek(1860.5);
  assert.equal(mic.currentTime, 1860.5);
  assert.equal(meeting.currentTime, 1860);
  await transport.play();
  assert.equal(mic.starts, 2);
  assert.equal(meeting.starts, 1);
  assert.equal(transport.time, 1860.5);
});

test('long recording pointer previews do not seek until release, then resume both sources once', async () => {
  const mic = track(1861), meeting = track(1860), transport = new PlaybackTransport(() => [mic, meeting]);
  const previews = [], scrub = new PlaybackScrub(transport, time => previews.push(time));
  await transport.play();
  scrub.begin();
  for (let i = 1; i <= 100; i++) scrub.move(i * 10);
  assert.equal(previews.at(-1), 1000);
  assert.deepEqual(mic.seeks, []);
  assert.deepEqual(meeting.seeks, []);
  assert.equal(scrub.finish(), true);
  assert.deepEqual(mic.seeks, [1000]);
  assert.deepEqual(meeting.seeks, [1000]);
  assert.equal(scrub.finish(), false);
  await transport.play();
  assert.equal(mic.starts, 2);
  assert.equal(meeting.starts, 2);
});

test('cancelled pointer drag keeps the previous time, and reset does not resume pending playback', async () => {
  const media = track(120), transport = new PlaybackTransport(() => [media]);
  transport.seek(12);
  const previews = [], scrub = new PlaybackScrub(transport, time => previews.push(time));
  scrub.begin(); scrub.move(90);
  assert.equal(scrub.finish(false), false);
  assert.equal(media.currentTime, 12);
  assert.equal(previews.at(-1), 12);
  let release;
  media.play = () => new Promise(resolve => { release = () => { media.paused = false; resolve(); }; });
  const pending = transport.play();
  transport.pause(); transport.seek(0); release(); await pending;
  assert.equal(media.paused, true);
  assert.equal(media.currentTime, 0);
  assert.equal(transport.playing, false);
});

test('seek waits for all source metadata and a failed source stops a late loading source too', async () => {
  const mic = track(120), meeting = track(NaN), transport = new PlaybackTransport(() => [mic, meeting]);
  assert.equal(transport.duration, 0);
  const scrub = new PlaybackScrub(transport, () => {});
  scrub.begin(); assert.equal(scrub.active, false);
  meeting.duration = 119;
  assert.equal(transport.duration, 120);
  let release;
  mic.play = async () => { throw new Error('load failed'); };
  meeting.play = () => new Promise(resolve => { release = () => { meeting.paused = false; resolve(); }; });
  const playing = transport.play();
  await Promise.resolve(); release();
  await assert.rejects(playing, /load failed/);
  assert.equal(meeting.paused, true);
  assert.equal(transport.playing, false);
});

test('switching meetings stops a pending track even after its element ref has detached', async () => {
  const media = track(120);
  let tracks = [media], release;
  media.play = () => new Promise(resolve => { release = () => { media.paused = false; resolve(); }; });
  const transport = new PlaybackTransport(() => tracks), pending = transport.play();
  tracks = []; transport.pause(); release(); await pending;
  assert.equal(media.paused, true);
});

test('play retries a failed initial media load after the retained audio becomes available',async()=>{
  const media=track(10);media.error={code:4};let loads=0;
  media.load=()=>{loads++;media.error=null;};
  media.play=async()=>{if(media.error)throw new Error('initial audio fetch failed');media.paused=false;};
  const transport=new PlaybackTransport(()=>[media]);
  await transport.play();assert.equal(loads,1);assert.equal(transport.playing,true);
});
