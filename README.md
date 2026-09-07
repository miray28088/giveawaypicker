# Giveaway Winner Picker

Fetch comments from a public Instagram / TikTok / YouTube post (or paste them manually) and draw fair, random winners using a Fisher–Yates shuffle.

## Setup

```bash
npm install
npx playwright install chromium
node server.js
```

Then open **http://localhost:3000**

## How it works

- **Fetch from URL mode**: The server launches a headless Chromium browser (Playwright), navigates to the post, auto-scrolls to trigger lazy-loaded comments, and scrapes visible `{ username, text }` pairs.
- **Paste manually mode**: 100% reliable fallback — paste comments (one per line, `username: text` or just usernames) and the same selection engine runs on them.
- **Selection engine**: filters by minimum `@mentions`, a required word/hashtag, and optional per-user deduplication, then runs a Fisher–Yates shuffle and slices out winners + backups.
- **Export**: results can be downloaded as `.txt` or `.csv`.

## Important limitations — please read

This scrapes public web pages without logging in, which real-world platforms actively resist:

- **Instagram, TikTok, and YouTube frequently require a logged-in session to render comments at all**, and none of them offer this as a supported/documented feature — this is unauthenticated, best-effort DOM scraping, not an official API.
- Class names and page structure **change often**, so the CSS selectors in `server.js` (`scrapeInstagram`, `scrapeTikTok`, `scrapeYouTube`) may need updating over time.
- Automated, non-human traffic can trigger **bot-detection / CAPTCHAs**, which will make navigation succeed but comment-scraping return nothing.
- Scraping a platform may run against that platform's **Terms of Service** — you're responsible for checking the terms of whichever platform you point this at and using it in a compliant way (e.g., only on your own posts, or with permission).
- Because of all of the above, **the "paste comments manually" mode is the dependable option** — copy the visible comments from the post yourself and paste them in; the draw logic is identical either way.

## Fairness

Winner selection uses the [Fisher–Yates shuffle](https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle), which produces a uniformly random permutation — every eligible entrant has an equal chance of being selected, and the process runs entirely server-side so it can't be tampered with from the browser.

## Project structure

```
giveaway-picker/
├── package.json
├── server.js          # Express server, Playwright scraping, selection engine
├── public/
│   └── index.html      # Single-page dark UI, confetti, CSV/TXT export
└── README.md
```
