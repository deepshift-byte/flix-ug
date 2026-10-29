import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { createToken } from '../src/tokens/token-service';
import { topUp, getBalance } from '../src/tokens/ledger';
import { startSession, confirmOffset, completeSession } from '../src/sessions/session-service';

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
  return { db, tokenNumber, sessionId: started.sessionId };
}

describe('completeSession', () => {
  it('debits exactly once when every byte is confirmed and checksum matches', () => {
    const { db, tokenNumber, sessionId } = startTenMegabyteMovie();
    confirmOffset(db, sessionId, 10 * MB, now);
    expect(completeSession(db, sessionId, 'f', now)).toEqual({ ok: true, chargedUgx: 1000 });
    expect(getBalance(db, tokenNumber)).toBe(4000);
    const row = db.prepare('select status from sessions where id = ?').get(sessionId) as { status: string };
    expect(row.status).toBe('complete');
  });
  it('refuses completion when bytes are missing', () => {
    const { db, tokenNumber, sessionId } = startTenMegabyteMovie();
    confirmOffset(db, sessionId, 9 * MB, now);
    expect(completeSession(db, sessionId, 'f', now)).toEqual({ ok: false, reason: 'incomplete' });
    expect(getBalance(db, tokenNumber)).toBe(5000);
  });
  it('refuses completion on checksum mismatch and does not charge', () => {
    const { db, tokenNumber, sessionId } = startTenMegabyteMovie();
    confirmOffset(db, sessionId, 10 * MB, now);
    expect(completeSession(db, sessionId, 'wrong', now)).toEqual({ ok: false, reason: 'checksum_mismatch' });
    expect(getBalance(db, tokenNumber)).toBe(5000);
    const row = db.prepare('select status from sessions where id = ?').get(sessionId) as { status: string };
    expect(row.status).toBe('active');
  });
  it('a second completion call does not charge again', () => {
    const { db, tokenNumber, sessionId } = startTenMegabyteMovie();
    confirmOffset(db, sessionId, 10 * MB, now);
    completeSession(db, sessionId, 'f', now);
    expect(completeSession(db, sessionId, 'f', now)).toEqual({ ok: false, reason: 'not_active' });
    expect(getBalance(db, tokenNumber)).toBe(4000);
  });
});
