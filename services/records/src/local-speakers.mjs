import { randomUUID } from 'node:crypto';
import { speakerHash } from '../../../packages/records/src/speakers.mjs';

export function normalizedVoice(vector) {
  if (!Array.isArray(vector) || vector.length !== 512 || !vector.every(Number.isFinite)) return null;
  const norm = Math.hypot(...vector);
  return Number.isFinite(norm) && norm > 1e-8 ? vector.map(value => value / norm) : null;
}
export const voiceSimilarity = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
export function validDiarization(slices, durationMs) {
  return Array.isArray(slices) && slices.length <= 64 && slices.every((slice, index) => slice && (!index || slice.start >= slices[index - 1].end) && Number.isSafeInteger(slice.start) && Number.isSafeInteger(slice.end) && slice.start >= 0 && slice.end > slice.start && slice.end / 16 <= durationMs && typeof slice.overlap === 'boolean' && (slice.embedding === undefined || normalizedVoice(slice.embedding)));
}
const meetings = new Map();
// Acoustic continuity is bounded, volatile state. Only explicit enrollment persists a vector.
export function labelLocalTurns(record, turns) {
  const key = `${record.owner}:${record.id}:${record.generation}`, now = Date.now();
  for (const [id, meeting] of meetings) if (now - meeting.updatedAt > 30 * 60000) meetings.delete(id);
  if (!meetings.has(key) && meetings.size >= 64) meetings.delete(meetings.keys().next().value);
  const meeting = meetings.get(key) || { profiles: [], updatedAt: now };
  meeting.updatedAt = now; meetings.delete(key); meetings.set(key, meeting);
  record.speakers ||= [];
  return turns.map(turn => {
    const vector = normalizedVoice(turn.embedding), { embedding: _privateVector, ...publicTurn } = turn;
    if (!vector || turn.overlap) return publicTurn;
    const ranked = meeting.profiles.map(profile => ({ profile, score: voiceSimilarity(vector, profile.vector) })).sort((a, b) => b.score - a.score);
    let profile = ranked[0]?.score >= 0.55 && (ranked.length < 2 || ranked[0].score - ranked[1].score >= 0.08) ? ranked[0].profile : null;
    if (!profile && meeting.profiles.length < 32) {
      profile = { id: speakerHash(record.id, randomUUID()), vector }; meeting.profiles.push(profile);
    }
    if (!profile) return publicTurn;
    let speaker = record.speakers.find(speaker => speaker.id === profile.id);
    if (!speaker) { speaker = { id: profile.id, hash: profile.id, label: `说话人 ${record.speakers.length + 1}` }; record.speakers.push(speaker); }
    return { ...publicTurn, speakerId: speaker.id, speakerHash: speaker.hash, speaker: speaker.label };
  });
}
