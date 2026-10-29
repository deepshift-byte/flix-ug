# FLIX-UG Hardware Acceptance Checklist

Plan: `docs/superpowers/plans/2026-10-29-flix-ug-token-download-engine.md` (Task 14).
Build under test: branch `main`, last commit `748e2bf` or later.

Status key: **Done (software)** = verified here without hardware; **Pending (hardware)** = must run on real equipment before rollout.

## Verified in software (this session)

| Scenario | Result |
|---|---|
| Full HTTP flow on the compiled server: start, three chunks (last one short), confirm, complete; bytes match source; charged once | Done (software) |
| Phone page in Chromium: download, reload-resume, save, "Saved, finish", storage cleared, no page errors | Done (software) |
| Pricing, PIN lockout, ledger idempotency, one active session per token, abandonment, last-chunk payment, completion | Done (software, 76 automated tests) |
| Kiosk resume after an in-process "power cut" (journal and partial file left on disk) | Done (software; simulated) |

## Pending (hardware)

- [ ] **Flash disk pulled mid-copy, then reinserted.** Expect: copy resumes from the confirmed offset, no double charge, no lost bytes.
- [ ] **Real power cut during a kiosk transfer** (USB stick and PC). Expect: journal and `.part` recover on restart; the file is correct; the balance is charged once.
- [ ] **Power cut after "complete" but before the rename.** Expect: restart finishes the rename without charging.
- [ ] **Flash disk too small for the movie.** Expect: `insufficient_space`, no `.part` left, session abandoned, balance unchanged.
- [ ] **Two kiosks spending one token at the same moment.** Expect: one succeeds, the other gets `active_session_exists`.
- [ ] **Android phone, full download over shop Wi-Fi**, including a dropped connection mid-way and a reopen. Expect: resume, one charge at the last chunk.
- [ ] **iOS Safari phone, full download.** Expect: completes, or is documented as a limitation (spec section 9 risk). Record the storage limit reached.
- [ ] **Phone with low free storage.** Expect: a clear message, resumable after space is freed, nothing lost.
- [ ] **Memory on a low-end phone while assembling a large movie** (spec review issue 5). Record peak memory; decide whether streaming hashing is needed.

## Sign-off

| Item | Tester | Date | Result | Notes |
|---|---|---|---|---|
|  |  |  |  |  |
