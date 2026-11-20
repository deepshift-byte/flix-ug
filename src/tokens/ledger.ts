import { transaction, type Db } from '../db.js';

export class InsufficientBalance extends Error {
  constructor(public readonly balanceUgx: number, public readonly requiredUgx: number) {
    super(`balance ${balanceUgx} is below required ${requiredUgx}`);
    this.name = 'InsufficientBalance';
  }
}

type TokenRow = { id: number; balance_ugx: number };

function requirePositiveInteger(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RangeError(`amount must be a positive integer, got ${amount}`);
  }
}

function findToken(db: Db, tokenNumber: string): TokenRow {
  const row = db.prepare('select id, balance_ugx from tokens where token_number = ?').get(tokenNumber) as
    | TokenRow
    | undefined;
  if (!row) throw new Error(`unknown token ${tokenNumber}`);
  return row;
}

export function topUp(db: Db, tokenNumber: string, amountUgx: number, paymentRef: string): void {
  requirePositiveInteger(amountUgx);
  transaction(db, () => {
    const token = findToken(db, tokenNumber);
    const existing = db
      .prepare("select id from ledger where type = 'top_up' and reference = ?")
      .get(paymentRef);
    if (existing) return;

    db.prepare("insert into ledger (token_id, type, amount_ugx, reference) values (?, 'top_up', ?, ?)").run(
      token.id,
      amountUgx,
      paymentRef,
    );
    db.prepare('update tokens set balance_ugx = balance_ugx + ? where id = ?').run(amountUgx, token.id);
    db.prepare("insert into audit_log (actor, action, subject, detail) values ('system', 'top_up', ?, ?)").run(
      tokenNumber,
      `${amountUgx} UGX ref ${paymentRef}`,
    );
  });
}

export function debit(db: Db, tokenNumber: string, amountUgx: number, sessionId: string): void {
  requirePositiveInteger(amountUgx);
  transaction(db, () => {
    const token = findToken(db, tokenNumber);
    // A repeat of an already-posted debit succeeds without posting again, even if the balance is now short.
    const existing = db.prepare("select id from ledger where type = 'debit' and reference = ?").get(sessionId);
    if (existing) return;

    if (token.balance_ugx < amountUgx) throw new InsufficientBalance(token.balance_ugx, amountUgx);

    db.prepare("insert into ledger (token_id, type, amount_ugx, reference) values (?, 'debit', ?, ?)").run(
      token.id,
      amountUgx,
      sessionId,
    );
    db.prepare('update tokens set balance_ugx = balance_ugx - ? where id = ?').run(amountUgx, token.id);
    db.prepare("insert into audit_log (actor, action, subject, detail) values ('system', 'debit', ?, ?)").run(
      tokenNumber,
      `${amountUgx} UGX session ${sessionId}`,
    );
  });
}

export function getBalance(db: Db, tokenNumber: string): number {
  return findToken(db, tokenNumber).balance_ugx;
}
