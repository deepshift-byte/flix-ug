import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { createToken } from '../src/tokens/token-service';
import { topUp, debit, getBalance, InsufficientBalance } from '../src/tokens/ledger';

describe('ledger', () => {
  it('a top-up with the same payment reference posts once', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 5000, 'pay-1');
    topUp(db, tokenNumber, 5000, 'pay-1');
    expect(getBalance(db, tokenNumber)).toBe(5000);
  });
  it('debit equal to balance leaves zero', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 1000, 'pay-1');
    debit(db, tokenNumber, 1000, 'sess-1');
    expect(getBalance(db, tokenNumber)).toBe(0);
  });
  it('debit with the same session ID posts once', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 5000, 'pay-1');
    debit(db, tokenNumber, 1000, 'sess-1');
    debit(db, tokenNumber, 1000, 'sess-1');
    expect(getBalance(db, tokenNumber)).toBe(4000);
  });
  it('refuses a debit that would make the balance negative', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 999, 'pay-1');
    expect(() => debit(db, tokenNumber, 1000, 'sess-1')).toThrow(InsufficientBalance);
    expect(getBalance(db, tokenNumber)).toBe(999);
  });
  it('writes an audit row for every top-up and debit', () => {
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 5000, 'pay-1');
    debit(db, tokenNumber, 1000, 'sess-1');
    const n = db.prepare("select count(*) as n from audit_log where action in ('top_up','debit')").get() as { n: number };
    expect(n.n).toBe(2);
  });
});
