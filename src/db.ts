import { DatabaseSync } from 'node:sqlite';
import { readAsset } from './assets.js';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(readAsset('schema.sql'));
  return db;
}

const depth = new WeakMap<Db, number>();

// Runs fn in a transaction. Nested calls use savepoints, so an inner failure rolls back only its own work.
export function transaction<T>(db: Db, fn: () => T, mode: 'deferred' | 'immediate' = 'deferred'): T {
  const level = depth.get(db) ?? 0;
  const savepoint = `flix_sp_${level}`;
  db.exec(level === 0 ? (mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN') : `SAVEPOINT ${savepoint}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    throw err;
  } finally {
    depth.set(db, level);
  }
}
