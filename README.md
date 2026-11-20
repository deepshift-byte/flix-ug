# FLIX-UG

Shop software for selling movies as soft copies. Customers browse a Netflix-style shop screen, watch
trailers, fill a cart and pay with a prepaid token and PIN; the movies are copied to their flash disk or
phone. Each title is charged once, when its last chunk has been sent, so an interrupted copy can be
continued without paying again.

## Try it on a Windows PC

1. Put `flix-ug.exe` in its own folder and double-click it. Windows may warn that the program is from an
   unknown publisher, because it is not signed: choose **More info → Run anyway**. Allow it through the
   firewall if you want phones on your Wi-Fi to reach it.
2. Keep the black window open. It shows the **attendant password** and a **demo token and PIN**.
3. Your browser opens the **shop screen** (`http://localhost:8080/`). Use **Google Chrome or Microsoft
   Edge**, because only they can save straight to a flash disk.
   - Scroll the rows, click a poster to see details and play the trailer, add titles to the cart.
   - Open the cart, **Checkout with token**, enter the demo token and PIN, then **Choose flash disk and
     download** and pick your flash disk.
4. The **attendant screen** is at `http://localhost:8080/admin` (password in the black window):
   - **Movies**: add a movie or series with its poster and trailer; it appears on the shop screen at once.
   - **Tokens**: sell a token (it shows the token number and PIN to give the customer), top one up.
   - **Downloads**: what has been downloaded, and the money earned.

The ten demo titles share one test file, which is not a playable video. Add real movies on the attendant
screen. Prices follow the shop rules: a movie or a series of up to 10 episodes costs 1,000 UGX; a series
of more than 10 episodes costs 2,000 UGX.

Everything is kept in the `flix-data` folder next to the program (database, catalog, uploaded movies,
passwords). Delete that folder to start again from scratch.

### Command line (optional)

Run these in a Command Prompt in the same folder:

```
flix-ug add-movie "C:\Movies\Some Film.mp4"            add a movie without the attendant screen
flix-ug add-movie "C:\Movies\Some Show.mp4" --series 12
flix-ug new-token --amount 5000                         sell a token (random 4-digit PIN)
flix-ug top-up <token> 2000
flix-ug balance <token>
flix-ug kiosk E:\ <token> <pin> <title-id>              copy one title to a flash disk, resumable
```

### Known limits of this test build

- Saving to a flash disk works in Chrome or Edge on the PC running FLIX-UG. Other shop PCs opening the
  shop over the network cannot save to a flash disk yet: browsers allow that only on `localhost` or HTTPS.
- If a flash-disk copy from the shop screen is interrupted, checkout again restarts that file from the
  beginning, at no extra charge. (The `kiosk` command resumes from where it stopped.)
- Mobile money (MTN), PayPal and SMS delivery of tokens are not built yet; tokens are sold on the
  attendant screen.

## Develop

```
npm install
npm test             # vitest
npm run build        # TypeScript to dist/
npm run build:exe    # release/flix-ug.exe (Windows) and release/flix-ug (Linux)
```

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`). Design documents are in
`docs/superpowers/`.
