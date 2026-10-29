# FLIX-UG: Token and Download Engine Design

Date: 2026-10-29
Status: Approved in conversation, pending final read
Scope: Sub-project 1 of 5 (tokens and resumable download engine). Catalog, kiosk browsing UI, attendant dashboard, and payments are separate specs.

## 1. Purpose

FLIX-UG lets a shop sell movies and TV series as soft copies. A customer buys a coupon (token) at the counter, spends its balance on downloads, and copies movies onto a flash disk or phone. The engine must:

- Charge the token correctly, so no movie is copied for free and no movie is charged twice.
- Survive interruptions (power loss, a removed flash disk, a dropped phone connection) and resume without loss or extra charge.
- Keep the server as the single source of truth for balances and download counts, since the attendant dashboard depends on them.

## 2. Confirmed Requirements

From the discussion:

- Prices: 1,000 UGX for a movie, or a TV series of up to 10 episodes. 2,000 UGX for a series with more than 10 episodes.
- A coupon is a balance in UGX. A 5,000 coupon can buy five 1,000 movies, or one 2,000 series plus three movies. File size does not matter.
- Tokens have a server-generated number (letters and digits) plus a PIN. Only the owner can use a token.
- Downloads go to a USB flash disk on a shop computer, a customer's phone over shop Wi-Fi, or both.
- Interrupted downloads resume from where they stopped.

Assumptions confirmed in review: the UGX balance model, and re-downloads cost again.

## 3. Architecture

One **Shop Server** runs on the attendant's machine. **Kiosk Clients** run on shop computers. **Phone Access** is a web page served by the server. All traffic stays on the shop's local network. The stack is Node.js with TypeScript and SQLite (a single file, easy to back up).

Components, one job each:

- **Token Service**: creates tokens, hashes and checks PINs, tracks balances, applies top-ups. Exposes a "create token" call that the later payments spec will use.
- **Pricing Rules**: a pure function from title type and episode count to price. No storage.
- **Download Sessions**: opens a session on start, tracks confirmed bytes and checksums, debits the token on completion, handles resume and expiry.
- **Kiosk Client**: writes to the flash disk, keeps a partial file and a journal until the download is verified, asks the server where to resume.
- **Phone Access**: serves the download page and chunk endpoints. The page saves chunks in browser storage and assembles the file.

## 4. Data Model

SQLite tables:

**tokens**
- `id`, `token_number` (unique, letters and digits, server-generated)
- `pin_hash`
- `balance_ugx`
- `status` (active, locked, disabled)
- `failed_pin_attempts`, `locked_until`
- `created_at`

**ledger** (append-only)
- `id`, `token_id`, `type` (`top_up` or `debit`), `amount_ugx`
- `reference` (payment ID for top-ups, session ID for debits; unique per type to prevent double-posting)
- `created_at`

**sessions**
- `id` (random, 128-bit), `token_id`, `title_id`
- `price_ugx` (snapshot at session start)
- `destination` (`usb` or `phone`)
- `expected_size`, `chunk_size` (4 MB), `chunk_hashes`, `file_checksum` (SHA-256)
- `bytes_confirmed`
- `status` (`active`, `complete`, `abandoned`)
- `last_activity_at`, `created_at`

Balances are derived from the ledger and cached on `tokens.balance_ugx`. The cache is updated in the same transaction as each ledger write.

## 5. Rules

- **Pricing** is computed from the title's type and episode count at session start, and stored on the session.
- **One active session per token.** A second start is refused while one is active.
- **Reservation, not charge.** Starting a session checks that the balance covers the price, but does not debit it.
- **Charge on completion only.** When every byte is confirmed and the final checksum matches, the debit and the session's `complete` status are written in one transaction. The ledger reference is the session ID, so a retry cannot charge twice.
- **Abandonment.** A session with no activity for 24 hours (configurable) becomes `abandoned`. Nothing is charged. The token may start a new session.
- **PIN lockout.** Five consecutive wrong PINs lock the token for 15 minutes (configurable).
- **Re-downloads cost again.**

## 6. Download Protocol

Files are split into 4 MB chunks, each with its own SHA-256. A final SHA-256 covers the whole file.

1. **Start**: the client sends token number, PIN, title, and destination. The server returns `session_id`, file size, chunk size, chunk hashes, and the final checksum.
2. **Fetch**: the client requests each chunk with an HTTP `Range` header. Each chunk request carries a short-lived signed link tied to the session.
3. **Verify and confirm**: the client checks the chunk hash, writes it, and flushes to disk. It then reports the new confirmed offset. The server records only confirmed bytes.
4. **Complete**: when all chunks are confirmed and the final checksum matches, the server debits the token and closes the session.

**Kiosk (USB) specifics:**
- Data is written to `<title>.part`. It is renamed to the final filename only after the final checksum passes.
- A small journal file on the stick stores the `session_id` and confirmed offset. On reconnect, or after a power loss, the kiosk reads the journal and resumes without customer action.
- Free space is checked before start. Nothing is reserved on disk.

**Resume rule:** the client asks the server for the confirmed offset and compares it with its local `.part` size. It trusts the smaller value and re-fetches everything after it.

**Phone specifics (option A):** the page fetches chunks in order, verifies each hash, and saves them in browser storage. When all chunks are present and the final checksum matches, it assembles and saves the file. Interrupted downloads resume from the last saved chunk. Phones need free storage roughly equal to the movie size. This works best on Android; iOS limits apply and are noted as a risk in section 9.

## 7. Error Handling

- **Power failure during a write:** the `.part` file and journal handle recovery. The server's confirmed offset is authoritative.
- **Server crash during completion:** the debit and completion are one transaction, and the ledger reference is unique per session. A retry cannot double-charge.
- **Chunk hash mismatch:** the chunk is discarded and re-fetched. After 3 failed attempts on the same chunk, the session is abandoned and the customer is told why.
- **Insufficient balance at start:** refused before any data moves. The screen shows the remaining balance.
- **Stick too small or full:** detected before the transfer starts.
- **Abandoned session:** cannot be resumed. The customer starts a new one. Nothing was charged, so the balance is unchanged.
- **Token locked:** the start request is refused until `locked_until` passes.

## 8. Security

- The server accepts connections only from the shop's local network.
- Session IDs are random 128-bit values. Chunk requests need a short-lived signed link, so a guessed session ID is not enough.
- Only the token's PIN, checked against its hash, authorizes a session. PINs are never stored or logged in plain text.
- Every balance change and admin action is written to an audit log.
- The attendant dashboard uses a separate admin login with a hashed password. Kiosks and phones cannot reach admin endpoints.

## 9. Risks and Open Items

- **iOS phone downloads:** Safari storage and download limits may stop large movies from completing. Needs a hardware test before the phone flow is promised to customers.
- **Phone storage:** a customer with little free space cannot complete a large movie. The page should check space before starting.
- **Clock drift:** lock and abandonment timers use the server clock only, so kiosk clocks are irrelevant.

## 10. Testing

- **Unit:** pricing boundaries (10 vs. 11 episodes, single movie), PIN hashing and lockout, ledger arithmetic, resume-offset logic.
- **Integration:** start → interrupt → resume → complete. Double completion attempts. Two sessions on one token. Abandonment after timeout.
- **Fault injection:** kill the server or client at each step. Corrupt individual chunks. Verify no double charge and no lost bytes.
- **Hardware (shop setup):** real flash disks, pulling a disk mid-copy, a real power cut during transfer, and a phone test on Android and iOS.

## 11. Out of Scope

Payments (MTN, PayPal, cash), SMS delivery, the catalog and trailers, the kiosk browsing UI, and the attendant dashboard UI. Each gets its own spec. The Token Service's "create token" and "top up" calls are the interfaces they will depend on.
