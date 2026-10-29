import type Database from 'better-sqlite3';
import { checkPin, hashPin } from './pin';
import { generateTokenNumber } from './token-number';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const MAX_NUMBER_ATTEMPTS = 5;

export type PinResult =
  | { ok: true }
  | { ok: false; reason: 'bad_pin' | 'locked' | 'unknown_token' | 'disabled'; lockedUntil?: Date };

type TokenRow = {
  id: number;
  pin_hash: string;
  status: string;
  failed_pin_attempts: number;
  locked_until: string | null;
};

export function createToken(db: Database.Database, pin: string): { tokenNumber: string } {
  const pinHash = hashPin(pin);
  const createdAt = new Date().toISOString();
  const insert = db.prepare('insert into tokens (token_number, pin_hash, created_at) values (?, ?, ?)');
  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
    const tokenNumber = generateTokenNumber();
    try {
      insert.run(tokenNumber, pinHash, createdAt);
      return { tokenNumber };
    } catch (err) {
      if (!(err instanceof Error) || !/UNIQUE/.test(err.message)) throw err;
    }
  }
  throw new Error('could not generate a unique token number');
}

export function verifyPin(db: Database.Database, tokenNumber: string, pin: string, now: Date): PinResult {
  return db.transaction((): PinResult => {
    const row = db
      .prepare('select id, pin_hash, status, failed_pin_attempts, locked_until from tokens where token_number = ?')
      .get(tokenNumber) as TokenRow | undefined;
    if (!row) return { ok: false, reason: 'unknown_token' };
    if (row.status === 'disabled') return { ok: false, reason: 'disabled' };

    if (row.locked_until && now < new Date(row.locked_until)) {
      return { ok: false, reason: 'locked', lockedUntil: new Date(row.locked_until) };
    }

    if (checkPin(pin, row.pin_hash)) {
      db.prepare('update tokens set failed_pin_attempts = 0, locked_until = null where id = ?').run(row.id);
      return { ok: true };
    }

    const attempts = row.failed_pin_attempts + 1;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000);
      db.prepare('update tokens set failed_pin_attempts = 0, locked_until = ? where id = ?').run(
        lockedUntil.toISOString(),
        row.id,
      );
      db.prepare(
        "insert into audit_log (actor, action, subject, detail, created_at) values ('system', 'token_locked', ?, ?, ?)",
      ).run(tokenNumber, `locked until ${lockedUntil.toISOString()}`, now.toISOString());
      return { ok: false, reason: 'locked', lockedUntil };
    }

    db.prepare('update tokens set failed_pin_attempts = ? where id = ?').run(attempts, row.id);
    return { ok: false, reason: 'bad_pin' };
  })();
}
