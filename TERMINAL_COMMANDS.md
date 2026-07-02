# Terminal Commands — Rapp Viewer

Quick reference for the local viewer. For the routines, see
`WEEKLY-UPDATE.md` (weekly) and `QUARTERLY-FULL-SCRAPE.md` (every 3 months).

## Start the viewer

Copy and paste into Terminal, press Enter:

```
cd /Users/gy/Documents/ClaudeCowork/GitHub/Rapp && python3 -m http.server 8765
```

Then open:
http://localhost:8765/index.html

Keep that Terminal window open while using the viewer.

## Stop the viewer

```
lsof -ti :8765 | xargs kill -9
```

Or just close the Terminal window running the server.

## Everything else

Scraping, tagging, AI descriptions, diff review, and deploy are all covered
step-by-step in `WEEKLY-UPDATE.md` and `QUARTERLY-FULL-SCRAPE.md`.

Reminder: never `git push` or deploy without explicit go-ahead — the site
is live and in use.
