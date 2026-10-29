import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { createToken } from '../src/tokens/token-service';
import { topUp, getBalance } from '../src/tokens/ledger';
import { startSession, expireAbandoned } from '../src/sessions/session-service';

const base = {
  titleId: 'title-1', kind: 'movie' as const, episodes: 1, destination: 'usb' as const,
  fileSize: 10, chunkHashes: ['h'], fileChecksum: 'f', now: new Date('2026-10-29T10:00:00Z'),
};

describe('startSession', () => {
  it('allows start when balance equals price', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 1000, 'pay-1');
    expect(startSession(db, { ...base, tokenNumber, pin: '4821' })).toMatchObject({ ok: true, priceUgx: 1000 });
  });
  it('refuses start when balance is one short of price', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 999, 'pay-1');
    expect(startSession(db, { ...base, tokenNumber, pin: '4821' })).toEqual({ ok: false, reason: 'insufficient_balance' });
  });
  it('does not debit the balance at start', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 5000, 'pay-1');
    startSession(db, { ...base, tokenNumber, pin: '4821' });
    expect(getBalance(db, tokenNumber)).toBe(5000);
  });
  it('concurrent starts yield one active session', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 5000, 'pay-1');
    const results = [
      startSession(db, { ...base, tokenNumber, pin: '4821' }),
      startSession(db, { ...base, tokenNumber, pin: '4821' }),
    ];
    expect(results.filter(r => r.ok).length).toBe(1);
    expect(results.find(r => !r.ok)).toEqual({ ok: false, reason: 'active_session_exists' });
  });
  it('a session with no activity for 24 hours is abandoned without charge', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 5000, 'pay-1');
    startSession(db, { ...base, tokenNumber, pin: '4821' });
    expect(expireAbandoned(db, new Date('2026-10-30T10:00:01Z'))).toBe(1);
    expect(getBalance(db, tokenNumber)).toBe(5000);
  });
});

describe('stale sessions', () => {
  it('a session stale for more than 24 hours no longer blocks a new start', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 5000, 'pay-1');
    startSession(db, { ...base, tokenNumber, pin: '4821' });
    const later = new Date(base.now.getTime() + 25 * 60 * 60 * 1000);
    expect(startSession(db, { ...base, tokenNumber, pin: '4821', now: later })).toMatchObject({ ok: true });
  });
});
