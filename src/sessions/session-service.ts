import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { priceFor, type TitleKind } from '../pricing';
import { getBalance } from '../tokens/ledger';
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
