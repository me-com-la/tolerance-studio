# Terminal Commands — Rapp Viewer

## Start the viewer

Copy and paste this into Terminal, then press Enter:

```
cd /Users/gy/Documents/ClaudeCowork/Rapp && python3 -m http.server 8765
```

Then open this in your browser: **http://localhost:8765/viewer.html**

The Terminal window needs to stay open while you're using the viewer.

---

## Stop the viewer

Open a **new** Terminal window, paste this, and press Enter:

```
lsof -ti :8765 | xargs kill -9
```

Or just close the Terminal window where the server is running.

---

## Run the Lexus scraper

Open Terminal, paste this, and press Enter:

```
cd /Users/gy/Documents/ClaudeCowork/Rapp && python3 lexus_scraper.py
```
