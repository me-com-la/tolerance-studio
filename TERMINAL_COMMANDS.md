# Terminal Commands — Rapp Viewer

## Start the viewer

Copy and paste into Terminal, press Enter:

```
cd /Users/gy/Documents/ClaudeCowork/GitHub/Rapp && python3 -m http.server 8765
```

Then open: **http://localhost:8765/viewer.html**

Keep that Terminal window open while using the viewer.

---

## Stop the viewer

```
lsof -ti :8765 | xargs kill -9
```

Or just close the Terminal window running the server.

---

## Generate AI descriptions for images

Run this once to describe all images that don't have a description yet:

```
cd /Users/gy/Documents/ClaudeCowork/GitHub/Rapp && python3 describe_images.py
```

Safe to re-run — skips images that already have descriptions. Toyota still has ~586 undescribed.

To run one brand at a time:

```
cd /Users/gy/Documents/ClaudeCowork/GitHub/Rapp && python3 describe_images.py --brand toyota
cd /Users/gy/Documents/ClaudeCowork/GitHub/Rapp && python3 describe_images.py --brand lexus
```

After it finishes, commit and push the updated manifests:

```
cd /Users/gy/Documents/ClaudeCowork/GitHub/Rapp && git add Toyota/manifest.json Lexus/manifest.json && git commit -m "Add AI descriptions to manifests" && git push
```

---

## Run the scrapers

```
cd /Users/gy/Documents/ClaudeCowork/GitHub/Rapp && python3 toyota_scraper.py
cd /Users/gy/Documents/ClaudeCowork/GitHub/Rapp && python3 lexus_scraper.py
```
