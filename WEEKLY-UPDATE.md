# Weekly Update — check for new/removed images

Takes ~15 minutes plus scan time. Everything through step 5 is local only.
Nothing touches git or the live site until you explicitly approve step 6.

```
scan → review by eye → add new → remove gone → re-tag → log it → (ask) deploy
```

## 1. Scan

```bash
cd /Users/gy/Documents/ClaudeCowork/GitHub/Rapp
python3 weekly_diff.py                 # both brands (do this normally)
python3 weekly_diff.py --brand lexus   # one brand only, if needed
```

Writes `diff_report.json`. No downloads, no changes to anything.

**If you scan only one brand:** the other brand's section in the report is
left over from its last scan. The report's date stamp covers the whole file,
so don't trust the date for the brand you didn't scan.

## 2. Review by eye — always

```bash
python3 -m http.server 8899
```

Open **http://127.0.0.1:8899/diff_review.html** (double-clicking the file
won't work — it has to be served).

**Never trust "removed" blindly.** If a model's page fails to load during
the scan, ALL of that model's images show up as "removed" (this happened
2026-07-01 with c-hr). The review page now shows a red warning banner at
the top of each brand's section listing any models it couldn't properly
check (page load failure, or the model wasn't even found during discovery)
— treat every "removed" entry for those models as untrustworthy. Red flag:
a whole model's worth of images in the removed list at once. When in doubt,
check the model's live page yourself or ask for a re-verify before deleting
anything.

"Added" is lower risk, but still look — a scan can pick up promo art you
don't want.

## 3. Add the approved new images

Re-run the normal scraper for the affected brand — it skips everything it
already has, so it only fetches what's new:

```bash
python3 toyota_scraper.py --models rav4pluginhybrid c-hr   # targeted (faster)
python3 toyota_scraper.py                                  # or whole brand
python3 lexus_scraper.py
```

> `download_new.py` exists as a faster path. Its catalog-ID bug is fixed
> (2026-07-01), but it still guesses model names from URLs, which are wrong
> for some models (grsupra2 vs grsupra, ux vs ux-hybrid — creates phantom
> models in the viewer). Until that's fixed, re-running the scraper is safer.

## 4. Remove the approved deletions

Only after step 2's eyeball review:

```bash
python3 apply_removed.py --brand toyota --url "https://..."   # one at a time (safest)
python3 apply_removed.py --brand toyota --all-reviewed        # everything in that
                                                              # brand's removed list
```

Deletes the file, its thumbnail, and its catalog entry. If the same file is
still used by another catalog entry (happens across model-year rollovers),
it removes only the entry and keeps the file — the viewer never breaks.
It trusts the report as-is — it re-verifies nothing.

## 5. Re-tag the new images

Both auto-skip anything already done, so run the whole brand:

```bash
python3 toyota_tagger.py           # face/people — free, on-device
python3 lexus_tagger.py

export ANTHROPIC_API_KEY=$(grep 'Anthropic image vision key' \
  /Users/gy/Documents/ClaudeCowork/keys-and-deploy.md | awk '{print $NF}')
python3 describe_images.py --brand toyota   # AI keywords, ~$0.02/image
python3 describe_images.py --brand lexus
```

Skip this and new images show up in the viewer with no keywords and no
people filter.

Keyword cleanup is automatic: describe_images.py finishes by running
condense_keywords.py, which merges near-duplicate keywords ("tires" →
"wheels") and backs the manifests up to `backups/` first. Nothing extra
to run.

## 6. Log it

```bash
python3 log_update.py --note "weekly pass"
```

Run this **once**, right after applying changes and **before** the next scan
overwrites `diff_report.json`. Running it twice logs the same pass twice.
If your scan was one brand only, use `--brand` here too, or it re-logs the
other brand's old results.

## 7. Verify locally, then (only when asked) deploy

With the step-2 server still running, open
**http://127.0.0.1:8899/index.html** — confirm new images appear, filter
right, open in the lightbox with keywords; confirm removed ones are gone.

Deploy = push `Lexus/manifest.json`, `Toyota/manifest.json`, `index.html`
(plus new library folders) to `me-com-la.github.io/library` — token in
`keys-and-deploy.md`. **Only with explicit go-ahead. Never as part of the
routine.**
