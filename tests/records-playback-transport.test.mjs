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
    duration, paused: true, seeks: [], starts: 0,
    get ended() { return currentTime >= duration; },
    get currentTime() { return currentTime; },
    set currentTime(time) { currentTime = time; this.seeks.push(time); },
    async play() { this.paused = false; this.starts++; },
    pause() { this.paused = true; },
  };
}

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
