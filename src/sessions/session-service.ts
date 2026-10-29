import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { priceFor, type TitleKind } from '../pricing';
import { debit, getBalance, InsufficientBalance } from '../tokens/ledger';
import { verifyPin } from '../tokens/token-service';
import { CHUNK_SIZE } from '../download/chunks';

const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

export type StartInput = {
  tokenNumber: string;
  pin: string;
  titleId: string;
  kind: TitleKind;
  episodes: number;
  destination: 'usb' | 'phone';
  fileSize: number;
  chunkHashes: string[];
  fileChecksum: string;
  now: Date;
};

export type StartResult =
  | { ok: true; sessionId: string; priceUgx: number }
  | {
      ok: false;
      reason:
        | 'bad_pin'
        | 'locked'
        | 'unknown_token'
        | 'disabled'
        | 'insufficient_balance'
        | 'active_session_exists';
    };

export function startSession(db: Database.Database, input: StartInput): StartResult {
  return db.transaction((): StartResult => {
    const auth = verifyPin(db, input.tokenNumber, input.pin, input.now);
    if (!auth.ok) return { ok: false, reason: auth.reason };

    const priceUgx = priceFor(input.kind, input.episodes);
    if (getBalance(db, input.tokenNumber) < priceUgx) return { ok: false, reason: 'insufficient_balance' };

    const tokenId = (db.prepare('select id from tokens where token_number = ?').get(input.tokenNumber) as { id: number }).id;
    const sessionId = randomBytes(16).toString('hex');
    const nowIso = input.now.toISOString();
    try {
      db.prepare(
        `insert into sessions (id, token_id, title_id, price_ugx, destination, expected_size, chunk_size,
           chunk_hashes, file_checksum, status, last_activity_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        sessionId,
        tokenId,
        input.titleId,
        priceUgx,
        input.destination,
        input.fileSize,
        CHUNK_SIZE,
        JSON.stringify(input.chunkHashes),
        input.fileChecksum,
        nowIso,
        nowIso,
      );
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) return { ok: false, reason: 'active_session_exists' };
      throw err;
    }
    return { ok: true, sessionId, priceUgx };
  }).immediate();
}

export function expireAbandoned(db: Database.Database, now: Date): number {
  const cutoff = new Date(now.getTime() - ABANDON_AFTER_MS).toISOString();
  const result = db
    .prepare("update sessions set status = 'abandoned' where status = 'active' and last_activity_at < ?")
    .run(cutoff);
  return result.changes;
}

export type ConfirmResult =
  | { ok: true; bytesConfirmed: number }
  | { ok: false; reason: 'not_active' | 'offset_backwards' | 'offset_past_end' };

export function confirmOffset(db: Database.Database, sessionId: string, offset: number, now: Date): ConfirmResult {
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`offset must be a non-negative integer, got ${offset}`);
  return db.transaction((): ConfirmResult => {
    const row = db
      .prepare('select status, expected_size, bytes_confirmed from sessions where id = ?')
      .get(sessionId) as { status: string; expected_size: number; bytes_confirmed: number } | undefined;
    if (!row || row.status !== 'active') return { ok: false, reason: 'not_active' };
    if (offset < row.bytes_confirmed) return { ok: false, reason: 'offset_backwards' };
    if (offset > row.expected_size) return { ok: false, reason: 'offset_past_end' };

    db.prepare('update sessions set bytes_confirmed = ?, last_activity_at = ? where id = ?').run(
      offset,
      now.toISOString(),
      sessionId,
    );
    return { ok: true, bytesConfirmed: offset };
  })();
}

export type CompleteResult =
  | { ok: true; chargedUgx: number }
  | { ok: false; reason: 'not_active' | 'incomplete' | 'checksum_mismatch' | 'insufficient_balance' };

export function completeSession(
  db: Database.Database,
  sessionId: string,
  finalChecksum: string,
  now: Date,
): CompleteResult {
  return db.transaction((): CompleteResult => {
    const row = db
      .prepare(
        `select s.status, s.bytes_confirmed, s.expected_size, s.file_checksum, s.price_ugx, t.token_number
           from sessions s join tokens t on t.id = s.token_id where s.id = ?`,
      )
      .get(sessionId) as
      | {
          status: string;
          bytes_confirmed: number;
          expected_size: number;
          file_checksum: string;
          price_ugx: number;
          token_number: string;
        }
      | undefined;
    if (!row || row.status !== 'active') return { ok: false, reason: 'not_active' };
    if (row.bytes_confirmed !== row.expected_size) return { ok: false, reason: 'incomplete' };
    if (finalChecksum !== row.file_checksum) return { ok: false, reason: 'checksum_mismatch' };

    try {
      debit(db, row.token_number, row.price_ugx, sessionId);
    } catch (err) {
      if (err instanceof InsufficientBalance) return { ok: false, reason: 'insufficient_balance' };
      throw err;
    }

    db.prepare("update sessions set status = 'complete', last_activity_at = ? where id = ?").run(
      now.toISOString(),
      sessionId,
    );
    return { ok: true, chargedUgx: row.price_ugx };
  }).immediate();
}
