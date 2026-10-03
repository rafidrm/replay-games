# Replay Games

Browser-based entry and exit practice. Open [Two Stage](./two_stage/).

## Two Stage

- Five-minute replay clock, premarket screens, intraday gate, VWAP and EMA signals.
- Options entry, partial exits, runners, +25% take-profit milestones and plan checks.
- Import a personal replay pack through Library. Market data is not included here.
- Device-local progress, backup/restore, and offline app caching after the first visit.
- On iPhone, open in Safari and use Share → Add to Home Screen. Import the pack in that app.

No server, accounts, analytics, external fonts or external JavaScript packages.
The website and source are public. Imported data and saves are never uploaded.
Noindex asks search engines not to list the pages; it is not access control.
Keep a replay pack and progress backup before clearing browser data or moving devices.
This is a paper replay; it does not connect to a broker or execute real orders.

## Hosting

GitHub Pages: deploy from the `main` branch, repository root. `.nojekyll` is included.
All game URLs are relative and support a project path such as `/replay-games/two_stage/`.
To update the app, change the version in `two_stage/sw.js` with each release.
Existing clients get an Update ready button; updates do not erase local saves.
