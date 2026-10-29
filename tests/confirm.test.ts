import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { createToken } from '../src/tokens/token-service';
import { topUp } from '../src/tokens/ledger';
import { startSession, confirmOffset, expireAbandoned } from '../src/sessions/session-service';
import { CHUNK_SIZE } from '../src/download/chunks';

const MB = 1024 * 1024;
const now = new Date('2026-10-29T10:00:00Z');

function startTenMegabyteMovie() {
  const db = openDb(':memory:');
  const { tokenNumber } = createToken(db, '4821');
  topUp(db, tokenNumber, 5000, 'pay-1');
  const started = startSession(db, {
    tokenNumber, pin: '4821', titleId: 'title-1', kind: 'movie', episodes: 1, destination: 'usb',
    fileSize: 10 * MB, chunkHashes: [], fileChecksum: 'f', now,
  });
  if (!started.ok) throw new Error('setup failed');
  return { db, sessionId: started.sessionId };
}

describe('confirmOffset', () => {
  it('advances the confirmed offset', () => {
    const { db, sessionId } = startTenMegabyteMovie();
    expect(confirmOffset(db, sessionId, 4 * MB, now)).toEqual({ ok: true, bytesConfirmed: 4 * MB });
  });
  it('refuses an offset that moves backwards', () => {
    const { db, sessionId } = startTenMegabyteMovie();
    confirmOffset(db, sessionId, 8 * MB, now);
    expect(confirmOffset(db, sessionId, 4 * MB, now)).toEqual({ ok: false, reason: 'offset_backwards' });
  });
  it('accepts re-confirming the same offset', () => {
    const { db, sessionId } = startTenMegabyteMovie();
    confirmOffset(db, sessionId, 4 * MB, now);
    expect(confirmOffset(db, sessionId, 4 * MB, now)).toEqual({ ok: true, bytesConfirmed: 4 * MB });
  });
  it('refuses an offset past the end of the file', () => {
    const { db, sessionId } = startTenMegabyteMovie();
    expect(confirmOffset(db, sessionId, 11 * MB, now)).toEqual({ ok: false, reason: 'offset_past_end' });
  });
  it('refuses to confirm on a session that is not active', () => {
    const { db, sessionId } = startTenMegabyteMovie();
    expireAbandoned(db, new Date('2026-10-30T10:00:01Z'));
    expect(confirmOffset(db, sessionId, 4 * MB, now)).toEqual({ ok: false, reason: 'not_active' });
  });
  it('uses the shared chunk size constant', () => {
    expect(CHUNK_SIZE).toBe(4 * MB);
  });
});
