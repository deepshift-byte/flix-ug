import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';

function insertToken(db: ReturnType<typeof openDb>, tokenNumber = 'TOKEN00001') {
  return db
    .prepare("insert into tokens (token_number, pin_hash, created_at) values (?, 'x', '2026-10-29T10:00:00.000Z')")
    .run(tokenNumber).lastInsertRowid as number;
}

function insertSession(db: ReturnType<typeof openDb>, tokenId: number, id: string, status: string) {
  db.prepare(
    `insert into sessions (id, token_id, title_id, price_ugx, destination, expected_size, chunk_size,
       chunk_hashes, file_checksum, status, last_activity_at, created_at)
     values (?, ?, 't1', 1000, 'usb', 10, 4194304, '[]', 'f', ?, '2026-10-29T10:00:00.000Z', '2026-10-29T10:00:00.000Z')`,
  ).run(id, tokenId, status);
}

describe('schema', () => {
  it('creates the four tables', () => {
    const db = openDb(':memory:');
    const names = db.prepare("select name from sqlite_master where type='table'").all().map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['tokens', 'ledger', 'sessions', 'audit_log']));
  });
  it('rejects a second debit with the same session reference', () => {
    const db = openDb(':memory:');
    const tokenId = insertToken(db);
    const insert = db.prepare("insert into ledger (token_id, type, amount_ugx, reference) values (?, 'debit', 1000, 'sess-1')");
    insert.run(tokenId);
    expect(() => insert.run(tokenId)).toThrow(/UNIQUE/);
  });
  it('allows only one active session per token', () => {
    const db = openDb(':memory:');
    const tokenId = insertToken(db);
    insertSession(db, tokenId, 's1', 'active');
    expect(() => insertSession(db, tokenId, 's2', 'active')).toThrow(/UNIQUE/);
  });
  it('allows an active session after the previous one completed', () => {
    const db = openDb(':memory:');
    const tokenId = insertToken(db);
    insertSession(db, tokenId, 's1', 'complete');
    expect(() => insertSession(db, tokenId, 's2', 'active')).not.toThrow();
  });
});
