# Quarterly Full Scrape — every ~3 months

Full re-scrape of both brands. Catches everything the weekly diffs might
have missed and picks up brand-new models. Every script skips what's already
done, so this is safe to re-run and safe to interrupt.

```
scrape both brands → face-tag → AI keywords → verify → (ask) deploy
```

## 1. Scrape

```bash
cd /Users/gy/Documents/ClaudeCowork/GitHub/Rapp
python3 lexus_scraper.py
python3 toyota_scraper.py
```

Takes a while (it walks every model page). Watch the terminal output for
models that fail — a failed model just means its images didn't refresh this
pass, but note it and re-run targeted:

```bash
python3 toyota_scraper.py --models 4runner camry
```

**After the scrape, check the model list it printed.** If a new "model"
appears that isn't a real vehicle (a sales-event page, etc.), say so — the
Toyota model discovery can be fooled by new marketing pages and the fix is
a one-line blocklist entry in `toyota_scraper.py`.

## 2. Face/people tagging (free, on-device)

```bash
python3 lexus_tagger.py
python3 toyota_tagger.py
```

## 3. AI keywords (~$0.02/image, only new images get billed)

```bash
export ANTHROPIC_API_KEY=$(grep 'Anthropic image vision key' \
  /Users/gy/Documents/ClaudeCowork/keys-and-deploy.md | awk '{print $NF}')
python3 describe_images.py --brand lexus
python3 describe_images.py --brand toyota
```

Keyword cleanup is automatic: describe_images.py finishes by running
condense_keywords.py, which merges near-duplicate keywords ("tires" →
"wheels") and backs the manifests up to `backups/` first.

## 4. Verify locally

```bash
python3 -m http.server 8899
```

Open **http://127.0.0.1:8899/index.html** — spot-check new models and
images, filters, lightbox keywords.

## 5. Log + deploy (only when asked)

Optionally log the pass:

```bash
python3 log_update.py --note "quarterly full scrape"
```

Deploy = push manifests + `index.html` + new library folders to
`me-com-la.github.io/library` (token in `keys-and-deploy.md`).
**Explicit go-ahead required — the site is live and in use.**
