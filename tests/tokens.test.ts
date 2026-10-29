import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { createToken, verifyPin } from '../src/tokens/token-service';
import { checkPin, hashPin } from '../src/tokens/pin';
import { generateTokenNumber } from '../src/tokens/token-number';

describe('PIN hashing', () => {
  it('never stores the plain PIN and verifies the right one', () => {
    const h = hashPin('4821');
    expect(h).not.toContain('4821');
    expect(checkPin('4821', h)).toBe(true);
    expect(checkPin('4822', h)).toBe(false);
  });
});

describe('verifyPin lockout', () => {
  it('locks after five wrong PINs and unlocks after 15 minutes', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    const t0 = new Date('2026-10-29T10:00:00Z');
    for (let i = 0; i < 5; i++) verifyPin(db, tokenNumber, '0000', t0);
    expect(verifyPin(db, tokenNumber, '4821', t0)).toMatchObject({ ok: false, reason: 'locked' });
    const t1 = new Date('2026-10-29T10:15:01Z');
    expect(verifyPin(db, tokenNumber, '4821', t1)).toEqual({ ok: true });
  });
  it('resets the failure count after a correct PIN', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    const t0 = new Date('2026-10-29T10:00:00Z');
    for (let i = 0; i < 4; i++) verifyPin(db, tokenNumber, '0000', t0);
    verifyPin(db, tokenNumber, '4821', t0);
    for (let i = 0; i < 4; i++) verifyPin(db, tokenNumber, '0000', t0);
    expect(verifyPin(db, tokenNumber, '4821', t0)).toEqual({ ok: true });
  });
});

describe('generateTokenNumber', () => {
  it('produces 10 letters-and-digits characters', () => {
    expect(generateTokenNumber()).toMatch(/^[A-Za-z0-9]{10}$/);
  });
});
