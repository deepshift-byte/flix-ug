# FLIX-UG Hardware Acceptance Checklist

Plan: `docs/superpowers/plans/2026-10-29-flix-ug-token-download-engine.md` (Task 14).
Build: `c1f21ff` or later. Scratch harness (not committed): `.superpowers/smoke/` (`scenarios.mjs`, `kiosk-run.mjs`, `browser2.cjs`).

**Important:** no physical flash disks, phones or power cuts were available. Each item below says exactly what was run. "Simulated" and "emulated" results do **not** replace the real-hardware check.

## Results

| # | Scenario | What was run | Result | Still needs real hardware |
|---|---|---|---|---|
| 1 | Flash disk pulled mid-copy, then reinserted | Simulated: kiosk process SIGKILLed after chunk 1, disk lazily unmounted, remounted on a 32 MB loop-mounted ext4 disk, kiosk restarted | **PASS** (1a–1e): resumed at chunk 1, file matches source, charged once | Real USB stick removal |
| 2 | Power cut during a kiosk transfer | Simulated: process SIGKILLed mid-chunk 2; partial file holds exactly 8 MB; restart fetched only chunk 2 | **PASS** (2a–2e) | A real power cut. SIGKILL does not test whether fsync survives power loss |
| 3 | Power cut after complete, before rename | Simulated: process SIGKILLed after the server returned complete | **PASS** (3a–3c): rename finished, no second fetch, no second charge | Real power cut |
| 4 | Flash disk too small | Real: 8 MB ext4 loop disk with about 3 MB free | **PASS** (4a–4c): `insufficient_space`, no partial file, session abandoned, nothing charged | The kernel's own disk-full error path (the free-space check refused first) |
| 5 | Two kiosks spend one token at once | Real HTTP: two simultaneous start requests to the live server | **PASS**: one 200, one 409 | Two physical kiosks |
| 6 | Android, full download with a dropped connection | Emulated: Chromium with a Pixel 5 profile; one chunk connection aborted; reload | **PASS** (6a–6f): paused with message, nothing charged, resumed on reload, one charge, file matches, no page errors | Android hardware, real Wi-Fi |
| 7 | iOS Safari, full download | **Not run**: no iOS device, no WebKit in this environment | — | Everything |
| 8 | Phone with low free storage | Emulated: IndexedDB writes refused (QuotaExceededError); space "freed" and the page reopened | **PASS** (8a–8d) after one product fix (see below) | Real phone storage limits |
| 9 | Memory on a low-end phone assembling a large movie | **Not run**: no device. The streaming hash is verified for correctness only (79/79 tests) | — | A measured run with a large movie |

## Findings from this run

- **Fixed:** after a storage-full pause, resubmitting the form was refused with "already downloading somewhere else", although the paused download belonged to this device. The page now resumes the device's own unfinished session. The server still refuses any second start.
- **Fixed:** the phone assembled the whole movie in memory to hash it. It now hashes one 4 MB chunk at a time (incremental SHA-256), and chunks are stored as Blobs. Correctness is tested; the memory benefit on a real phone is not yet measured (item 9).
- **Not a product bug:** an early run of scenario 3 failed because earlier copies filled the test disk, so the free-space check correctly refused.

## Sign-off

| Item | Tester | Date | Result | Notes |
|---|---|---|---|---|
|  |  |  |  |  |
