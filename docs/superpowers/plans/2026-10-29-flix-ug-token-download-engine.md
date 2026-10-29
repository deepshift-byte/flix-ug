# FLIX-UG Token and Download Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shop-server engine that sells UGX-balance tokens, starts and resumes chunked movie downloads for USB and phone destinations, and charges a token only when a download is complete and verified.

**Architecture:** One Node.js/TypeScript Shop Server backed by a single SQLite file holds all balances, sessions, and the audit trail. Pure modules (pricing, PIN hashing, chunk planning, resume math) sit under thin service modules that own transactions. Kiosk and phone clients are thin consumers of the same HTTP chunk protocol; the kiosk adds a journal file and a `.part` writer, the phone page adds browser-side chunk storage.

**Tech Stack:** Node.js 20+, TypeScript, `better-sqlite3`, `vitest`, `fastify` (HTTP), Node `crypto` (scrypt, HMAC, SHA-256). No native crypto libraries beyond Node's built-ins.

**Spec:** `docs/superpowers/specs/2026-10-29-flix-token-download-engine-design.md`

Project root for all code: `/home/user/flix-ug/`. Paths below are relative to it.

## Global Constraints

- Prices are integer UGX: a movie is 1000; a series of 10 or fewer episodes is 1000; a series of more than 10 episodes is 2000.
- Chunk size is exactly `4 * 1024 * 1024` bytes. The last chunk may be shorter. Each chunk gets its own SHA-256; the whole file gets a final SHA-256.
- Token numbers are server-generated, use letters and digits only, and are unique.
- PINs are stored only as scrypt hashes. Never store, log, or return a PIN in plain text.
- Five consecutive wrong PINs lock a token for 15 minutes. Lock expiry is stored in the database as `locked_until`, not kept in memory.
- A session with no activity for 24 hours becomes `abandoned`. Nothing is charged.
- One active session per token, enforced by the database.
- A debit and its session's `complete` status are written in one transaction. The ledger reference is the session ID, unique per debit.
- Chunk hash failures: re-fetch a chunk up to 3 times, then abandon the session.
- The server accepts connections only from the shop LAN (RFC 1918 ranges and loopback).
- Re-downloads are charged every time. There is no deduplication.
- The git repository is initialized in Task 1. Each task ends with a commit.

## Review Focus

These are the five inputs most likely to break for a real shop customer. Each is pinned to a test in the task that owns the code.

1. **Balance exactly equal to price** (5,000 coupon, five 1,000 movies): must succeed. A 999 balance for a 1,000 movie must be refused. → Task 6 test `allows_start_when_balance_equals_price`.
2. **Last chunk shorter than 4 MB** (a file size that is not a multiple of the chunk size): final chunk length and hash must be correct, and completion must succeed. → Task 5 test `last_chunk_is_shorter_when_size_not_multiple`.
3. **Flash disk swapped between sessions**: a journal from one session must not be reused for a different session or title. The kiosk starts fresh. → Task 9 test `ignores_journal_for_different_session`.
4. **Two simultaneous starts on the same token** (two kiosks tapping at once): exactly one succeeds. → Task 6 test `concurrent_starts_yield_one_active_session`.
5. **Phone storage fills during assembly**: the page reports the error, does not claim completion, and nothing is charged. → Task 10 test `storage_quota_error_does_not_report_complete`.

---

### Task 1: Project scaffold and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/index.ts` (empty export, placeholder for the server entry point)
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` runs vitest; `npm run build` compiles TypeScript to `dist/`.

- [ ] **Step 1: Write the failing smoke test**

```ts
// tests/smoke.test.ts
import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index';

describe('smoke', () => {
  it('exports a version string', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/flix-ug && npx vitest run tests/smoke.test.ts`
Expected: FAIL (module `src/index` does not exist yet)

- [ ] **Step 3: Scaffold the project**

Run `git init`, `npm init -y`, then install `typescript`, `vitest`, `better-sqlite3`, `@types/better-sqlite3`, `fastify`. Set `"type": "module"`, `"test": "vitest run"`, `"build": "tsc"`. Export `VERSION = '0.1.0'` from `src/index.ts`. `.gitignore` covers `node_modules/`, `dist/`, `*.db`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/smoke.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold FLIX-UG project and test harness"
```

---

### Task 2: Pricing rules

**Files:**
- Create: `src/pricing.ts`
- Test: `tests/pricing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `priceFor(kind: 'movie' | 'series', episodes: number): number` (integer UGX). Movies ignore `episodes`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/pricing.test.ts
import { describe, it, expect } from 'vitest';
import { priceFor } from '../src/pricing';

describe('priceFor', () => {
  it('prices a movie at 1000', () => {
    expect(priceFor('movie', 1)).toBe(1000);
  });
  it('prices a series of 10 episodes at 1000', () => {
    expect(priceFor('series', 10)).toBe(1000);
  });
  it('prices a series of 11 episodes at 2000', () => {
    expect(priceFor('series', 11)).toBe(2000);
  });
  it('prices a series of 20 episodes at 2000', () => {
    expect(priceFor('series', 20)).toBe(2000);
  });
  it('rejects a series with zero or negative episodes', () => {
    expect(() => priceFor('series', 0)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pricing.test.ts`
Expected: FAIL (`priceFor` not defined)

- [ ] **Step 3: Implement `priceFor` in `src/pricing.ts`**

A pure function. Throw on `episodes < 1` for series. Return 1000 or 2000 as specified in Global Constraints.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pricing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pricing.ts tests/pricing.test.ts && git commit -m "feat: add pricing rules"
```

---

### Task 3: Database schema and migrations

**Files:**
- Create: `src/db.ts`, `src/schema.sql`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `openDb(path: string): Database.Database` (runs migrations; `':memory:'` allowed). Tables: `tokens`, `ledger`, `sessions`, `audit_log`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/db.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';

describe('schema', () => {
  it('creates the four tables', () => {
    const db = openDb(':memory:');
    const names = db.prepare("select name from sqlite_master where type='table'").all().map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['tokens', 'ledger', 'sessions', 'audit_log']));
  });
  it('rejects a second debit with the same session reference', () => {
    const db = openDb(':memory:');
    // insert a token, then two debit rows with the same reference
    expect(() => { /* two inserts with type='debit' and same reference */ }).toThrow();
  });
  it('allows only one active session per token', () => {
    const db = openDb(':memory:');
    // insert token, insert two sessions with status='active' for it
    expect(() => { /* second insert */ }).toThrow();
  });
});
```

Fill in the two `/* */` placeholders with real inserts when implementing; the tests must insert real rows and assert the constraint fires.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL (`openDb` not defined)

- [ ] **Step 3: Implement the schema in `src/schema.sql` and `openDb` in `src/db.ts`**

Column list follows the spec, section 4. Constraints:
- `ledger`: unique index on `(type, reference)`.
- `sessions`: partial unique index on `token_id` where `status = 'active'`.
- `tokens.token_number`: unique.
- `audit_log`: `id`, `actor`, `action`, `subject`, `detail`, `created_at`.
- All money columns are `INTEGER` UGX.

`openDb` enables `PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL`, then runs `schema.sql`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/schema.sql tests/db.test.ts && git commit -m "feat: add SQLite schema with uniqueness constraints"
```

---

### Task 4: Token creation and PIN verification

**Files:**
- Create: `src/tokens/pin.ts`, `src/tokens/token-number.ts`, `src/tokens/token-service.ts`
- Test: `tests/tokens.test.ts`

**Interfaces:**
- Consumes: `openDb` (Task 3).
- Produces:
  - `generateTokenNumber(): string` (letters and digits, 10 characters)
  - `hashPin(pin: string): string`, `checkPin(pin: string, hash: string): boolean`
  - `createToken(db, pin: string): { tokenNumber: string }`
  - `verifyPin(db, tokenNumber: string, pin: string, now: Date): { ok: true } | { ok: false; reason: 'bad_pin' | 'locked' | 'unknown_token' | 'disabled'; lockedUntil?: Date }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/tokens.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { createToken, verifyPin } from '../src/tokens/token-service';
import { checkPin, hashPin } from '../src/tokens/pin';

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
```

(Import `generateTokenNumber` from `../src/tokens/token-number` in the test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tokens.test.ts`
Expected: FAIL (modules not defined)

- [ ] **Step 3: Implement the three modules**

- `pin.ts`: scrypt with a random 16-byte salt, stored as `salt:hash`. Compare with `timingSafeEqual`.
- `token-number.ts`: `crypto.randomBytes` mapped onto a 62-character alphabet. Retry on collision is handled by the database unique constraint in `createToken`.
- `token-service.ts`: `verifyPin` reads `locked_until` from the database. If `now` is before `locked_until`, return `locked`. On a wrong PIN, increment `failed_pin_attempts`; at 5, set `locked_until = now + 15 min` and reset the counter. On a correct PIN, reset the counter. Each lock event writes an audit row.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tokens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tokens tests/tokens.test.ts && git commit -m "feat: token creation, PIN hashing, and lockout"
```

---

### Task 5: Ledger, balances, and top-ups

**Files:**
- Create: `src/tokens/ledger.ts`
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Consumes: `openDb`, `createToken` (Tasks 3, 4).
- Produces:
  - `topUp(db, tokenNumber: string, amountUgx: number, paymentRef: string): void` (idempotent by `paymentRef`)
  - `debit(db, tokenNumber: string, amountUgx: number, sessionId: string): void` (idempotent by `sessionId`; throws `InsufficientBalance` if the balance would go negative)
  - `getBalance(db, tokenNumber: string): number`
  - `class InsufficientBalance extends Error`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ledger.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ledger.test.ts`
Expected: FAIL (`ledger` module not defined)

- [ ] **Step 3: Implement `src/tokens/ledger.ts`**

Each function runs inside `db.transaction`. `debit` reads the cached balance, checks it covers the amount, inserts the ledger row, updates `tokens.balance_ugx`, and writes the audit row. If the ledger insert hits the unique index, return without change (idempotent). Amounts are integers; reject non-integer or non-positive amounts.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ledger.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tokens/ledger.ts tests/ledger.test.ts && git commit -m "feat: ledger with idempotent top-ups and debits"
```

---

### Task 6: Download session start and abandonment

**Files:**
- Create: `src/sessions/session-service.ts`
- Test: `tests/session-start.test.ts`

**Interfaces:**
- Consumes: `verifyPin` (Task 4), `getBalance` (Task 5), `priceFor` (Task 2), `openDb` (Task 3).
- Produces:
  - `startSession(db, input: { tokenNumber: string; pin: string; titleId: string; kind: 'movie' | 'series'; episodes: number; destination: 'usb' | 'phone'; fileSize: number; chunkHashes: string[]; fileChecksum: string; now: Date }): { ok: true; sessionId: string; priceUgx: number } | { ok: false; reason: 'bad_pin' | 'locked' | 'unknown_token' | 'disabled' | 'insufficient_balance' | 'active_session_exists' }`
  - `expireAbandoned(db, now: Date): number` (returns count marked abandoned)

Note: `fileSize`, `chunkHashes`, and `fileChecksum` come from the catalog spec. For this sub-project, tests pass them in directly.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/session-start.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { createToken } from '../src/tokens/token-service';
import { topUp } from '../src/tokens/ledger';
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
```

Add `import { getBalance } from '../src/tokens/ledger';` to the imports before running.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session-start.test.ts`
Expected: FAIL (`session-service` not defined)

- [ ] **Step 3: Implement `startSession` and `expireAbandoned`**

`startSession` runs in one `BEGIN IMMEDIATE` transaction: verify PIN (Task 4), check the token is not locked, compute price with `priceFor`, check balance covers it, insert the session as `active` with the price snapshot. The partial unique index from Task 3 turns a second concurrent insert into `active_session_exists`; catch that constraint error and return the reason. Store `chunkHashes` as JSON.

`expireAbandoned` marks `active` sessions whose `last_activity_at` is older than 24 hours as `abandoned`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/session-start.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sessions tests/session-start.test.ts && git commit -m "feat: session start with reservation and abandonment"
```

---

### Task 7: Chunk planning and confirmation

**Files:**
- Create: `src/download/chunks.ts`
- Modify: `src/sessions/session-service.ts` (add `confirmOffset`)
- Test: `tests/chunks.test.ts`, `tests/confirm.test.ts`

**Interfaces:**
- Consumes: `startSession` (Task 6).
- Produces:
  - `CHUNK_SIZE = 4 * 1024 * 1024`
  - `chunkRange(fileSize: number, index: number): { start: number; end: number }` (end exclusive; last chunk may be shorter)
  - `chunkCount(fileSize: number): number`
  - `confirmOffset(db, sessionId: string, offset: number, now: Date): { ok: true; bytesConfirmed: number } | { ok: false; reason: 'not_active' | 'offset_backwards' | 'offset_past_end' }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/chunks.test.ts
import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, chunkCount, chunkRange } from '../src/download/chunks';

describe('chunk planning', () => {
  it('last chunk is shorter when size is not a multiple of chunk size', () => {
    const size = CHUNK_SIZE * 2 + 100;
    expect(chunkCount(size)).toBe(3);
    expect(chunkRange(size, 2)).toEqual({ start: CHUNK_SIZE * 2, end: CHUNK_SIZE * 2 + 100 });
  });
  it('exact multiple has no short chunk', () => {
    expect(chunkCount(CHUNK_SIZE * 2)).toBe(2);
    expect(chunkRange(CHUNK_SIZE * 2, 1)).toEqual({ start: CHUNK_SIZE, end: CHUNK_SIZE * 2 });
  });
});
```

Rename the first test to `last_chunk_is_shorter_when_size_not_multiple` to match Review Focus item 2.

```ts
// tests/confirm.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { createToken } from '../src/tokens/token-service';
import { topUp } from '../src/tokens/ledger';
import { startSession, confirmOffset } from '../src/sessions/session-service';

describe('confirmOffset', () => {
  it('advances the confirmed offset', () => { /* start session, confirm 4 MB, expect bytesConfirmed 4 MB */ });
  it('refuses an offset that moves backwards', () => { /* confirm 8 MB then 4 MB -> offset_backwards */ });
  it('refuses an offset past the end of the file', () => { /* file size 10 MB, confirm 11 MB -> offset_past_end */ });
  it('refuses to confirm on a session that is not active', () => { /* complete or abandon first -> not_active */ });
});
```

Fill the bodies using the same setup as Task 6 (a token with enough balance; a `fileSize` of 10 MB). Write them out in full when implementing, following the pattern of `tests/session-start.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chunks.test.ts tests/confirm.test.ts`
Expected: FAIL (modules not defined)

- [ ] **Step 3: Implement**

`chunks.ts`: pure arithmetic. `chunkCount` is `Math.ceil(size / CHUNK_SIZE)`. `chunkRange` returns `start = index * CHUNK_SIZE` and `end = Math.min(start + CHUNK_SIZE, size)`.

`confirmOffset`: the offset must be `>= bytes_confirmed` and `<= expected_size`, and the session must be `active`. Update `bytes_confirmed` and `last_activity_at` in one statement.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/chunks.test.ts tests/confirm.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/download src/sessions tests/chunks.test.ts tests/confirm.test.ts && git commit -m "feat: chunk planning and confirmed-offset tracking"
```

---

### Task 8: Signed chunk links

**Files:**
- Create: `src/download/signed-link.ts`
- Test: `tests/signed-link.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `signLink(params: { sessionId: string; chunkIndex: number; expiresAt: Date }, secret: Buffer): string` (returns a query string, e.g. `exp=...&sig=...`)
  - `verifyLink(params: { sessionId: string; chunkIndex: number }, query: { exp: string; sig: string }, secret: Buffer, now: Date): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/signed-link.test.ts
import { describe, it, expect } from 'vitest';
import { signLink, verifyLink } from '../src/download/signed-link';

const secret = Buffer.from('test-secret-32-bytes-long-xxxxxx');
const p = { sessionId: 's1', chunkIndex: 3 };
const exp = new Date('2026-10-29T10:10:00Z');

describe('signed chunk links', () => {
  it('verifies a valid link before expiry', () => {
    const q = Object.fromEntries(new URLSearchParams(signLink({ ...p, expiresAt: exp }, secret)));
    expect(verifyLink(p, q as any, secret, new Date('2026-10-29T10:05:00Z'))).toBe(true);
  });
  it('rejects after expiry', () => {
    const q = Object.fromEntries(new URLSearchParams(signLink({ ...p, expiresAt: exp }, secret)));
    expect(verifyLink(p, q as any, secret, new Date('2026-10-29T10:11:00Z'))).toBe(false);
  });
  it('rejects a link for a different chunk', () => {
    const q = Object.fromEntries(new URLSearchParams(signLink({ ...p, expiresAt: exp }, secret)));
    expect(verifyLink({ ...p, chunkIndex: 4 }, q as any, secret, new Date('2026-10-29T10:05:00Z'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/signed-link.test.ts`
Expected: FAIL (module not defined)

- [ ] **Step 3: Implement**

HMAC-SHA256 over `sessionId|chunkIndex|exp`. Compare with `timingSafeEqual`. The secret comes from an environment variable at server startup (Task 11), and is never hard-coded.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/signed-link.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/download/signed-link.ts tests/signed-link.test.ts && git commit -m "feat: HMAC-signed chunk links with expiry"
```

---

### Task 9: Completion, final checksum, and charge

**Files:**
- Modify: `src/sessions/session-service.ts` (add `completeSession`)
- Test: `tests/complete.test.ts`

**Interfaces:**
- Consumes: `confirmOffset` (Task 7), `debit` (Task 5), `chunkCount` (Task 7).
- Produces: `completeSession(db, sessionId: string, finalChecksum: string, now: Date): { ok: true; chargedUgx: number } | { ok: false; reason: 'not_active' | 'incomplete' | 'checksum_mismatch' | 'insufficient_balance' }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/complete.test.ts
import { describe, it, expect } from 'vitest';
// setup as in tests/confirm.test.ts; fileSize = 10 MB; fileChecksum = 'f'
describe('completeSession', () => {
  it('debits exactly once when every byte is confirmed and checksum matches', () => { /* expect chargedUgx 1000, balance drops by 1000, session complete */ });
  it('refuses completion when bytes are missing', () => { /* confirm 9 MB -> incomplete, balance unchanged */ });
  it('refuses completion on checksum mismatch and does not charge', () => { /* wrong checksum -> checksum_mismatch, balance unchanged, session still active */ });
  it('a second completion call does not charge again', () => { /* second call -> not_active, balance unchanged after first */ });
});
```

Write the bodies in full when implementing, following the setup in `tests/confirm.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/complete.test.ts`
Expected: FAIL (`completeSession` not defined)

- [ ] **Step 3: Implement `completeSession`**

In one `BEGIN IMMEDIATE` transaction: check `status = 'active'`, check `bytes_confirmed === expected_size`, compare `finalChecksum` with `file_checksum`, call `debit(db, token, price_ugx, sessionId)` (Task 5), then set `status = 'complete'`. Any failure rolls back the whole transaction. The ledger's unique `(type, reference)` index makes a retry harmless.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/complete.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sessions tests/complete.test.ts && git commit -m "feat: charge token once on verified completion"
```

---

### Task 10: Kiosk client (USB destination)

**Files:**
- Create: `src/kiosk/journal.ts`, `src/kiosk/resume.ts`, `src/kiosk/usb-download.ts`
- Test: `tests/kiosk-resume.test.ts`, `tests/kiosk-usb.test.ts`

**Interfaces:**
- Consumes: the HTTP chunk protocol (Task 11) via an injected `ServerClient` interface, `chunkRange` and `CHUNK_SIZE` (Task 7).
- Produces:
  - `interface ServerClient { startSession(input): Promise<StartResult>; fetchChunk(sessionId: string, index: number, link: SignedLink): Promise<Buffer>; confirm(sessionId: string, offset: number): Promise<void>; status(sessionId: string): Promise<{ bytesConfirmed: number; status: string }>; complete(sessionId: string, checksum: string): Promise<CompleteResult> }`
  - `readJournal(path: string): { sessionId: string; titleId: string } | null`, `writeJournal(path: string, j: { sessionId: string; titleId: string }): void`
  - `resumeOffset(serverOffset: number, localPartSize: number): number` (returns `Math.min`)
  - `downloadToUsb(opts: { client: ServerClient; usbDir: string; titleId: string; fileName: string; resumeSessionId?: string }): Promise<{ ok: true; path: string } | { ok: false; reason: string }>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/kiosk-resume.test.ts
import { describe, it, expect } from 'vitest';
import { resumeOffset } from '../src/kiosk/resume';
describe('resumeOffset', () => {
  it('trusts the smaller of server and local values', () => {
    expect(resumeOffset(8_000_000, 4_000_000)).toBe(4_000_000);
    expect(resumeOffset(4_000_000, 8_000_000)).toBe(4_000_000);
  });
});
```

```ts
// tests/kiosk-usb.test.ts
import { describe, it, expect } from 'vitest';
// Uses an in-memory fake ServerClient and a temp directory (os.tmpdir + mkdtemp).
describe('downloadToUsb', () => {
  it('ignores_journal_for_different_session', () => {
    // Write a journal for session A to the stick, then call downloadToUsb with
    // resumeSessionId 'B' (or a different titleId). Assert the kiosk starts a new
    // session and does not reuse the .part file.
  });
  it('resumes from the confirmed offset after a simulated power loss', () => {
    // Fake server confirms 8 MB, local .part has 4 MB -> the fetch begins at 4 MB.
  });
  it('writes to .part and renames only after final checksum passes', () => {
    // Before complete: only <title>.part exists. After: final file exists, .part gone.
  });
  it('retries a bad chunk up to 3 times then abandons', () => {
    // Fake fetchChunk returns wrong bytes 3 times -> result { ok: false, reason: 'chunk_failed' }.
  });
});
```

Fill in the bodies when implementing; the comments state the assertion for each.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/kiosk-resume.test.ts tests/kiosk-usb.test.ts`
Expected: FAIL (modules not defined)

- [ ] **Step 3: Implement**

- `resume.ts`: `Math.min`.
- `journal.ts`: JSON at `<usbDir>/.flix-journal.json`. Read returns `null` if the file is missing or unparseable.
- `usb-download.ts`: if a journal exists and its `sessionId` matches the resume request and its `titleId` matches, resume it. Otherwise discard the journal and start a new session. Write each chunk to `<fileName>.part` at its offset, `fsync` after each chunk, then call `client.confirm`. Verify each chunk's SHA-256 against the start response's `chunkHashes`; retry 3 times, then return `chunk_failed`. After the last chunk, compute the file SHA-256 and call `client.complete`. On success, rename `.part` to the final name and delete the journal.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/kiosk-resume.test.ts tests/kiosk-usb.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/kiosk tests/kiosk-resume.test.ts tests/kiosk-usb.test.ts && git commit -m "feat: kiosk USB download with journal and resume"
```

---

### Task 11: HTTP API and LAN restriction

**Files:**
- Create: `src/http/app.ts`, `src/http/lan-only.ts`, `src/server.ts`
- Modify: `src/index.ts` (export `buildApp`)
- Test: `tests/http.test.ts`

**Interfaces:**
- Consumes: all service modules from Tasks 4–9, `signLink`/`verifyLink` (Task 8).
- Produces:
  - `isLanAddress(ip: string): boolean` (RFC 1918 and loopback)
  - `buildApp(opts: { db; signingSecret: Buffer; clock?: () => Date }): FastifyInstance`
  - Routes: `POST /sessions` (start), `GET /sessions/:id` (status), `GET /sessions/:id/chunks/:index` (range fetch, requires signed query), `POST /sessions/:id/confirm`, `POST /sessions/:id/complete`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/http.test.ts
import { describe, it, expect } from 'vitest';
import { isLanAddress } from '../src/http/lan-only';
describe('isLanAddress', () => {
  it('accepts 10.x, 172.16-31.x, 192.168.x, and loopback', () => {
    for (const ip of ['10.0.0.5', '172.16.1.1', '172.31.9.9', '192.168.1.20', '127.0.0.1']) expect(isLanAddress(ip)).toBe(true);
  });
  it('rejects public addresses and 172.32.x', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '41.210.1.1']) expect(isLanAddress(ip)).toBe(false);
  });
});
```

Add route tests using `app.inject`: a chunk request without a valid signature returns 403; a `POST /sessions` from a public IP returns 403; a full start→confirm→complete flow returns 200 and charges the token.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/http.test.ts`
Expected: FAIL (modules not defined)

- [ ] **Step 3: Implement**

`lan-only.ts`: parse IPv4 and check the ranges. `app.ts`: a `preHandler` hook calls `isLanAddress(request.ip)` and returns 403 otherwise. The start route returns each chunk's signed link. The chunk route verifies the signature and expiry before streaming bytes from the movie file. `server.ts` reads `FLIX_SIGNING_SECRET` from the environment and refuses to start if it is missing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/http.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/http src/server.ts src/index.ts tests/http.test.ts && git commit -m "feat: HTTP API with LAN-only access and signed chunk routes"
```

---

### Task 12: Phone access page (browser side)

**Files:**
- Create: `public/phone/assemble.js`, `public/phone/index.html`
- Test: `tests/phone-assemble.test.ts` (runs in vitest with jsdom)

**Interfaces:**
- Consumes: the HTTP chunk protocol (Task 11).
- Produces:
  - `storeChunk(store: ChunkStore, sessionId: string, index: number, bytes: ArrayBuffer, expectedHash: string): Promise<boolean>` (returns false on hash mismatch and stores nothing)
  - `assemble(store: ChunkStore, sessionId: string, chunkCount: number, fileChecksum: string): Promise<{ ok: true; blob: Blob } | { ok: false; reason: 'missing_chunks' | 'checksum_mismatch' | 'storage_full' }>`
  - `interface ChunkStore` with `put`, `get`, `keys` (backed by IndexedDB in the browser; an in-memory map in tests)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/phone-assemble.test.ts
import { describe, it, expect } from 'vitest';
import { storeChunk, assemble, memoryStore } from '../public/phone/assemble';
describe('phone assembly', () => {
  it('storage_quota_error_does_not_report_complete', () => {
    // A store whose put() throws QuotaExceededError -> assemble never returns ok: true,
    // and the result is { ok: false, reason: 'storage_full' }.
  });
  it('rejects a chunk whose hash does not match and stores nothing', () => { /* storeChunk -> false, store.keys() empty */ });
  it('resumes by skipping chunks already stored', () => { /* store chunks 0 and 1, then fetch only 2 */ });
});
```

Implement `memoryStore` in the same module so tests can use it. Fill in the bodies when implementing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/phone-assemble.test.ts`
Expected: FAIL (module not defined)

- [ ] **Step 3: Implement**

`assemble.js` is a plain ES module with no build step. `storeChunk` hashes with `crypto.subtle.digest('SHA-256')`. `assemble` reads chunks in index order, builds a `Blob`, and verifies the final checksum. `index.html` loads the module, asks the server for the session, fetches missing chunks with `Range` requests, and shows progress. The `storage_full` reason is set when `put` throws `QuotaExceededError`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/phone-assemble.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/phone tests/phone-assemble.test.ts && git commit -m "feat: phone access page with chunked browser storage"
```

---

### Task 13: Fault-injection and end-to-end suite

**Files:**
- Create: `tests/e2e/flow.test.ts`, `tests/e2e/faults.test.ts`

**Interfaces:**
- Consumes: `buildApp` (Task 11), `downloadToUsb` (Task 10), phone `assemble` (Task 12).
- Produces: none. This task proves the spec's error-handling promises end to end.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/e2e/faults.test.ts
import { describe, it, expect } from 'vitest';
describe('fault injection', () => {
  it('no double charge when the client is killed after complete but before rename', () => { /* rerun complete -> balance debited once */ });
  it('no lost bytes when the process is killed mid-chunk', () => { /* resume -> final file hash matches */ });
  it('no charge for an abandoned session', () => { /* expireAbandoned, then balance unchanged */ });
  it('a corrupted chunk is re-fetched and the download still completes', () => { /* corrupt chunk 2 once -> ok */ });
});
```

```ts
// tests/e2e/flow.test.ts
import { describe, it, expect } from 'vitest';
describe('full flow', () => {
  it('start, interrupt, resume, complete charges 1000 for a movie', () => { /* token with 5000, one movie */ });
  it('a 5000 coupon completes exactly five 1000 movies and refuses the sixth', () => { /* Review Focus item 1 */ });
});
```

Fill in the bodies using `buildApp` and the fake `ServerClient`. Use real temporary directories for the USB stick.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/e2e`
Expected: FAIL until earlier tasks are complete. This task is written last.

- [ ] **Step 3: Implement any missing glue**

Fix only what these tests expose. No new features.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run`
Expected: PASS for the full suite.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e && git commit -m "test: end-to-end and fault-injection suite"
```

---

### Task 14: Hardware acceptance checklist (manual)

**Files:**
- Create: `docs/superpowers/plans/hardware-acceptance.md`

**Interfaces:**
- Consumes: a running Shop Server, a shop kiosk, real USB sticks, an Android phone, an iOS phone.
- Produces: a signed-off checklist with the date and results.

- [ ] **Step 1: Write the checklist file**

List each scenario from spec section 10 (Hardware): pull a flash disk mid-copy and reinsert; power cut mid-transfer on the kiosk; phone download on Android including a dropped connection; phone download on iOS; a phone with low storage; two kiosks spending one token at the same moment.

- [ ] **Step 2: Run each scenario on real hardware**

Record the result of each as PASS or FAIL with notes. Any FAIL goes back to the owning task.

- [ ] **Step 3: Confirm the iOS risk**

The spec's section 9 risk on iOS is resolved only when the iOS result is recorded. If iOS fails, the phone flow is limited to Android for the first release, and the spec is updated to say so.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/hardware-acceptance.md && git commit -m "docs: hardware acceptance checklist and results"
```

---

## Self-Review

**1. Spec coverage:** Pricing (T2); tokens, PIN hashing, lockout (T4); UGX balance and ledger, idempotent debits (T5); reservation, one active session, abandonment, exact-balance start (T6); chunk protocol and confirmation (T7); signed links (T8); charge on verified completion (T9); kiosk journal, resume, `.part` rename (T10); LAN-only access and HTTP routes (T11); phone assembly (T12); fault injection and end-to-end flows (T13); hardware tests and iOS risk (T14). Audit log is written in T4 and T5, and checked in T5. Admin login and dashboard are out of scope per spec section 11, so they have no task here.

**2. Step scan:** Task 1 scaffolding and Task 9 completion read as concrete. Tasks 7, 9, 10, 12, and 13 give test names with the assertion described in a comment rather than full bodies; each comment states the exact check, but the implementer writes the setup. This matches the "signature and test" rule. No "TBD" lines remain.

**3. Type consistency:** `verifyPin` (T4) returns the same reason union used in `startSession` (T6). `debit` (T5) is called by `completeSession` (T9) with `sessionId`, matching the ledger reference. `chunkCount` and `chunkRange` (T7) are used by T9 and T10. `signLink`/`verifyLink` (T8) match the route use in T11. `ServerClient` (T10) matches the routes in T11.

**4. Review Focus:** Each of the five items has a test named in its owning task: exact balance (T6), short last chunk (T7), journal mismatch (T10), concurrent starts (T6), storage full on the phone (T12). Each is present in the task body.

**5. Proportion:** The plan is about the length of the spec. Code blocks are test skeletons and signatures, not implementations.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-29-flix-ug-token-download-engine.md`. Please review the plan.

It has 14 tasks. Several depend on each other's interfaces (session service, ledger, chunk protocol), so they're best done in order. Which execution approach would you prefer?

- **Subagent-driven**: A fresh subagent implements each task and a fresh reviewer checks it before the next starts, then a whole-branch review at the end. Most thorough, but costs a fresh context per task and per review.
- **Native**: I implement every task myself in this session, then one fresh reviewer checks the whole branch at the end. Cheapest and fastest, with no independent review until the end.

For this plan I recommend **Subagent-driven**, because the tasks share interfaces and the token-charging logic is where a shipped mistake would cost real money. Does the plan capture what you want, and which approach should we use?

Two notes before you decide:
- The project directory is not a git repository yet. Task 1 runs `git init`, so the plan's commit steps will create the repo at `/home/user/flix-ug/`.
- Task 14 needs real hardware: flash disks, an Android phone, and an iOS phone. Without them, the plan completes up to Task 13.

