# FLIX-UG

Shop software for selling movies as soft copies: prepaid tokens with a PIN, resumable downloads to a
flash disk (kiosk) or a phone (browser page), and one charge per movie when its last chunk is served.

This repository holds the first sub-project: the token and download engine. See
`docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the plan and hardware checklist.

## Try it on a Windows PC

1. Build `release/flix-ug.exe` (below), or use a copy someone built for you.
2. Put `flix-ug.exe` in its own folder and double-click it. Windows may warn that the program is from an
   unknown publisher, because it is not signed: choose **More info → Run anyway**. Allow it through the
   firewall if you want phones on your Wi-Fi to reach it.
3. A window shows a demo token and PIN, and your browser opens the phone download page
   (`http://localhost:8080/phone/`). Enter the token, PIN and `demo-movie`.

The demo movie is test data, not a playable video. Add your own files, then restart the program:

```
flix-ug add-movie "C:\Movies\Some Film.mp4"
flix-ug add-movie "C:\Movies\Some Series.mp4" --series 12
```

Other commands (run in a Command Prompt in the same folder, while the server window stays open):

```
flix-ug new-token --amount 5000          sell a token (random 4-digit PIN)
flix-ug top-up <token> 2000              add balance
flix-ug balance <token>                  show balance
flix-ug kiosk E:\ <token> <pin> <title>  copy to a flash disk (run again to resume)
```

Data (database, catalog, signing key) is kept in `flix-data` next to the program.

## Develop

```
npm install
npm test             # vitest
npm run build        # TypeScript to dist/
npm run build:exe    # release/flix-ug.exe (Windows) and release/flix-ug (Linux)
```

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`).
