# Design notes — phase 1a hosted pipeline UI

Static mockups only. No backend wiring, no JS state — buttons and inputs are visual references for Dev to wire up in phase 1b/1c. Sample data pulled from real project folders under `clients/` (Kindtail "Blue", Wingstudio "Santa-Barbara-July-2026") so the copy and images are real, not lorem ipsum.

## Source of truth for brand
Followed `website/assets/styles.css` tokens directly, not the task brief's guess at "Space Grotesk / Inter" — the actual site uses:
- Display / headings: **Barlow Condensed** (700 weight, uppercase, tight letter-spacing)
- Body: **IBM Plex Sans**
- Mono (code, file names, settings, meta labels): **IBM Plex Mono**

## Color tokens (copied verbatim from styles.css, see `_tokens.css` in this folder)
- `--ink #111014` — primary text, dark surfaces (topbar text on dark, buttons)
- `--paper #f7f6f3` — page background
- `--card #ffffff` — panel/card background
- `--line rgba(17,16,20,.12)` / `--line-2 rgba(17,16,20,.22)` — borders, hairlines vs. stronger dividers
- `--muted #5d5b57` — secondary text
- `--accent #d8502d` (rust/orange) — primary brand accent, used sparingly: active rail step, AI-draft buttons, brand dot
- `--accent-ink #7a2a14` / `--accent-wash #fbeae3` — accent text-on-light and wash background pairs
- `--chip #eceae6` — neutral pill background (inactive rail step numbers, filter pills)
- `--radius 14px` — standard panel/card corner radius

### New tokens added for this app (not in the marketing site, needed for pipeline states)
Status pills use color + a small dot, one hue per step-status. All follow the ink-on-wash pattern used elsewhere in the site (see `.badge-soft` in styles.css):
- Brief/Tags: `#8a6d3b` on `#f6efdf` (amber-brown)
- Generating: `#1a4fa0` on `#e8f0fe` (blue — matches control.html's existing queued-badge blue)
- Checking: `#7a4fa0` on `#f1e8fb` (violet)
- Compose: `#b45309` on `#fff3e0` (amber — matches control.html's "you" badge color)
- Review: `#1f6f6b` on `#e2f1ef` (teal — reuses site's existing `--dev` teal, repurposed for "review")
- Delivered: `#2e7d32` on `#e8f5e9` (green — matches control.html's approved-badge green)

Checker verdict colors (screen 6) reuse the same green/red/amber semantics already in control.html: green = approved/pass, red `#a33` = rejected/fail, amber `#b45309` = human-review/flagged. These are carried straight over from `tools/control.html`'s existing `.ok/.bad/.ghost` button colors and `stage2_results.json`'s verdict vocabulary, so Dev can map 1:1.

## Type scale
- H1 (page title): `clamp(1.8rem, 3.5vw, 2.6rem)`, Barlow Condensed 700, uppercase
- H2 (panel/section title): `1.15–1.2rem`, Barlow Condensed 700, uppercase
- Body: `.85–.95rem` IBM Plex Sans
- Small / meta (dates, filenames, settings keys): `.7–.8rem`, often IBM Plex Mono
- Eyebrow / status pill text: `.65–.78rem`, uppercase, letter-spacing `.03–.14em`

## Spacing unit
Base unit is `.1rem` increments off a `1.6rem` page gutter (matches `.wrap{padding:0 clamp(1.2rem,4vw,2.4rem)}` in the site). Panels/cards use `1.6–1.7rem` internal padding on desktop, gaps between cards are `.8–1.2rem`. Corner radius is consistently `10px` for small controls (buttons, inputs, tag chips use `999px` pill) and `14px` (`--radius`) for panels/cards.

## Screen-by-screen interaction notes for Dev

**1. Login** — plain email/password form, no client login on this screen (clients only ever land on their review-link URL, screen 7, never see this page). "Sign in" is a real primary button; the secondary "client review link" button is a dead-end placeholder explaining where clients actually go.

**2. Project list** — grouped by client (Kindtail / Wingstudio / Toyota), each client group is its own `<div>` block with a repeatable card grid; card is a full-bleed clickable link (`<a class="proj-card">`), not a button — the whole card navigates to project view. Status pill vocabulary matches the 7-step rail exactly: `brief`, `generating`, `checking`, `compose`, `review`, `delivered` (brief/tags collapses steps 1 the way the rail's first two steps do — status reflects "furthest incomplete step"). Filter pills at top are a single-select row (only one `.active` at a time) — Dev should wire as radio-like behavior, not multi-select. The dashed "+ new project" card is a button-styled div at the end of a client's grid, not a fixed top-level control — placement follows control.html's per-client "new project" mental model.

**3. Project view** — the 7-step rail is the primary in-project nav, sticky under the topbar (`position:sticky;top:60px`). Rail steps are `<div class="rail-step">` with `.done` (green check) / `.active` (accent underline + filled number) / default (grey chip number) states — three visual states total, no "locked/future" fourth state, since Owner can jump to any step at any time (matches control.html's freeform `<details>` navigation, not a gated wizard). Below the rail: a two-column summary (tag preview snapshot + checker tally) and a "latest renders" mini-grid. Everything here is a read-only digest; edits happen on the dedicated step screens.

**4. Tags editor** — tag chips (`.tag.must/.should/.flavor`) are click targets that should cycle weight must→should→flavor→must on click (ported directly from control.html's `tagCycle()`), with the small `✕` inside each chip as a separate stop-propagation click target for delete. The "Ask Claude to draft tags" button (`.btn-ai`, accent-colored) is the one AI affordance on this screen — maps to `/ai-draft {kind:"tags"}` in server.py. The monospace preview block at the bottom (ALWAYS/PREFER/DETAIL) is read-only, derived from the chips above — Dev should regenerate it live on every chip change, not treat it as separately editable.

**5. Scenes editor** — numbered list of single-line text inputs (not a textarea) — one row per scene, each with its own delete `✕`. The settings strip (batch_size, aspect, master_size, model) is read-only display here (editable version lives in a project-settings panel, out of scope for this screen per control.html's actual `settingsBlock()` — worth flagging to Dev that step-level settings editing may still be needed somewhere in the hosted app). "Ask Claude to draft scenes" (`.btn-ai`) maps to `/ai-draft {kind:"scenes"}` + `/scenes-merge`. The "Expanded shots (auto)" table below the fold is generated/read-only — the product lock + style lock text blocks and the shots table should never be hand-edited, only regenerated via the "Expand shots" button, exactly like the `GENERATED_BELOW` marker convention in `prompts.md`.

**6. Checker/verdict gallery** — this is the highest-stakes screen for correctness. Card verdict states: `checker-pass` (not shown here since Blue's batch has none — see Wingstudio for a clean-pass example), `checker-fail` (red), `checker-review` (amber, low-confidence pass or flagged fail items). The override buttons (`approve` / `reject anyway`) are the *human override* action — once clicked, Dev's real implementation should flip the card to an `.override-badge` state (see the `crate-blue-hallway-08.png` card, which shows what a card looks like **after** an owner override — green "✓ owner approved" badge replacing the approve/reject buttons, plus the italic "override sticks" sticky-note). This directly encodes server.py's `/checker-verdict` rule: **owner override is final and sticky, a checker rerun never flips it.** Dev must never re-render the approve/reject buttons on a card that already has a human_override recorded — only the badge state.

**7. Review gallery (client-facing)** — deliberately the lightest-weight, warmest screen: no rail, no internal jargon, no checker/verdict language at all (client never sees "checker" or "rejected"). Only approved + composed images appear (pulled from `4-Selects` and `5-Size-Variations/composed`, per server.py's client bucket logic). Heart icon (`.fav-btn`) toggles filled/outline on click — that's the "favorite" affordance. Textarea under each image is the "comment" affordance, one comment per image, plain text, no rich formatting. "Download all as zip" button maps directly to server.py's existing `/zip?project=&dir=6-Client-Review` endpoint — same behavior, just hosted.

## Things intentionally left out (in scope for Dev, not Min)
- No client login screen included — spec only asked for a review gallery, and the plan (`saas-plan.md` phase 3) treats client auth as row-level-security enforced, not a separate login UI. Flag to Dev/Fable if a distinct client login page is wanted later.
- No empty/loading/error states drawn — all screens show the "happy path" with data. Dev should design these states following the same visual language (e.g. dashed-border "no tags yet" pattern already used in control.html's `tagsBlock()`).
- No responsive/mobile layout pass — grids use `auto-fill,minmax(...)` so they reflow reasonably on narrow viewports, but nothing was tested below ~375px.
