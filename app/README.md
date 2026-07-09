# Tolerance Studio — hosted app (phase 1b)

Plain HTML/JS + supabase-js from a CDN. No build step, no bundler. Open any
`.html` file directly in a browser, or serve the folder with any static
server (e.g. `python3 -m http.server` from inside `app/`) — both work
identically since there's no server-side routing.

## What's here

```
app/
  lib/
    supabase.js        Supabase client setup (URL + anon key, window.sb global)
    db.js               Data layer: listProjects, getProject, saveTags, saveScenes,
                        saveShots, listRenders, setVerdict, createRunLogEntry, etc.
  functions/
    _anthropic-key.js   SERVER-SIDE-ONLY key loader (mirrors server.py's anthropic_key())
    _higgsfield-key.js  DEAD — Higgsfield is no longer used for generation (see
                        generate.js below). Kept only because deleting it wasn't
                        asked for; nothing imports it anymore.
    ai-draft.js         Port of server.py's ai_draft() — tags | scenes | copy
    expand-shots.js     NEW capability — Scenes + tags -> expanded shot prompts
    checker.js          Port of spec-checker/check_stage2.py + run_checker.py's
                        sorting rule (sticky human_override respected)
    generate.js         The real "Generate & check these scenes now" step.
                        SWITCHED FROM HIGGSFIELD TO GEMINI (2026-07-06) —
                        Higgsfield's reference-accurate models
                        (marketing_studio_image/ms_image/nano_banana_2/
                        gpt_image_2) turned out to be MCP/CLI-only, not on the
                        developer REST API our Higgsfield key can reach (confirmed
                        from four independent sources after exhausting every
                        endpoint/slug guess); the only model reachable there
                        (Soul) was live-tested against the real Kindtail crate
                        photo and returned the WRONG PRODUCT. Now calls Gemini's
                        native image model directly (model: gemini-3.1-flash-image,
                        "Nano Banana 2") — plain REST, no CLI. Resolution
                        HARD-CAPPED at 1K (Owner rule) via imageConfig.imageSize,
                        a field verified empirically (a live 2K-size request
                        returned an actual 2048x2048 image) since a fetched summary
                        on this topic separately fabricated a nonexistent
                        "/v1beta/interactions" endpoint — don't trust that source
                        for this vendor without an independent check. Passes up to
                        3 reference photos from the project's storage assets/
                        folder per the real api-decision.md multi-reference rule
                        (complex products need 2-3 references, not one).
                        AUTO-CHAINS the checker immediately after each shot
                        uploads (old tool ran generation + checking together —
                        "ran step 3 automatically per the standing rule" per the
                        real Blue campaign run log), reusing the image bytes
                        already in memory as the checker's candidate, no re-fetch.
                        BUG FOUND + FIXED live: the candidate image sent to the
                        checker was hardcoded to mediaType 'image/png', but
                        Gemini doesn't always return PNG — it returned a real JPEG
                        once, and Anthropic's vision API rejects a mismatched
                        declared type outright. Fixed by using Gemini's own
                        reported mimeType everywhere instead of assuming one.
                        Live-tested end-to-end after the fix: generated:1,
                        checked:1, verdict approved, real Claude vision reasoning
                        attached to the render row. Two real products tested
                        (Kindtail crate, and a much harder case — an asymmetric
                        geometric Wingstudio vase with a triangular cutout, round
                        dowel accent, and incised lines) — both held product
                        identity faithfully.
  design/               Min's original static mockups — untouched, reference only
  migrations/
    001_init.sql        Already applied to the live Supabase project
  1-login.html          WIRED — real Supabase Auth (Owner sign-in)
  2-project-list.html   WIRED — reads projects.* live, client-grouped, status filter;
                        "+ New project" opens a real modal (openNewProject()):
                        pick or create a client, name the campaign, upload 1+ real
                        product reference photos — mirrors the old tool's
                        "1-Client-Assets" step, which nothing in the app had
                        built until 2026-07-06. First photo becomes
                        projects.reference_image. Every project before this modal
                        existed was seeded by hand via SQL, not created through
                        the app — this is the first real creation path.
  3-project-view.html   WIRED — project summary, tag preview, checker tally, renders
  4-tags-editor.html    WIRED — tag cycle/add/remove, saves to projects.tags;
                        "Ask Claude to draft tags" calls the deployed ai-draft
                        Edge Function for real (kind:'tags')
  5-scenes-editor.html  WIRED, fully — this page changed a lot after Owner
                        feedback (2026-07-06), see below.
                        Split into two visually separate sections: "AI
                        scenes" (dashed panel, draft button lives inside it —
                        re-drafting only replaces this section) on top, "Your
                        scenes" (your own add box) below. Each scene is
                        {t,src:'owner'|'ai'} — editing an AI line's text flips
                        it to yours immediately, badge included. Persisted as
                        numbered lines with a "*" marker for owner-written
                        ones; expand-shots strips both the numbering and the
                        marker before prompting. Batch size is a single
                        editable number that tracks the total scene count
                        automatically — generation_aspect/master_size/model
                        were removed from the UI (Owner call) and just keep
                        their settings.json defaults invisibly.
                        The "Expanded shots" table/panel is GONE entirely
                        (Owner call: the shot-expansion machinery should be
                        invisible — if you want a different shot, add a new
                        scene description, that's the only UI surface for it).
                        "Generate & check these scenes now" now runs the
                        WHOLE invisible middle of the pipeline in one click:
                        save scenes -> expand-shots (silent) -> generate
                        (Gemini, which also auto-runs the checker per shot)
                        -> redirect to Check. A full-screen takeover overlay
                        blocks the page during this ("don't refresh or leave"
                        note + a beforeunload guard) since a real batch can
                        take a few minutes and losing the tab mid-run would
                        be a real problem, not just an inconvenience.
  6-checker-gallery.html WIRED — reads renders, human_override is the only path
                        that can set a sticky verdict, mirrors server.py's rule
  7-review-gallery.html WIRED — client-facing, reads only 'approved' renders
```

## What's genuinely wired end-to-end today

- **Auth**: real Supabase Auth (`sb.auth.signInWithPassword`), session-gated
  redirect to login on every internal page.
- **Reads**: project list, project detail, tags, scenes, shots (if present),
  renders, checker verdicts — all live queries against the Supabase tables in
  `001_init.sql`, not mock data.
- **Writes**: tag add/remove/cycle + save, scenes add/remove/edit + save,
  checker approve/reject (writes `renders.human_override`, which
  `lib/db.js`'s `setCheckerResult()` respects as sticky — a future automated
  checker run can never flip it, matching `server.py`'s `/checker-verdict`
  and `run_checker.py`'s `overridden` bucket).
- **RLS**: not re-implemented client-side — the app relies entirely on the
  Postgres policies already in `001_init.sql`. The client review gallery
  (`7-review-gallery.html`) doesn't do its own access check; it just queries
  normally and Postgres returns nothing if the signed-in user isn't a
  `client_users` row for that project's client, or the project isn't at
  `review`/`delivered` status yet.

## Deployed & wired (2026-07-06 — real infrastructure, not a plan)

All four functions are live Supabase Edge Functions on the `tolerance-studio`
project (deployed via the personal access token — originally through the
Supabase CLI, since 2026-07-09 via the Management REST API directly
(`POST api.supabase.com/v1/projects/<ref>/functions/deploy?slug=<name>`,
multipart `metadata` + `file`) because no CLI/node/deno binary exists on this
machine anymore. NOT the MCP connector — that's tied to a different Supabase
account and can't reach this project). Secrets set: **`FAL_KEY` is the only
AI provider key any deployed function uses** — ai-draft/expand-shots/
expand-shots-pro/checker route through fal.ai's OpenRouter chat endpoint
(model Claude Haiku 4.5); generate/edit-render route image generation
through fal's hosted Gemini 3.1 Flash Image endpoint (same model as before,
just not called with a Google key directly anymore). `GEMINI_API_KEY`,
`ANTHROPIC_API_KEY`, and `HF_CREDENTIALS` are still set on the project but
no longer referenced by any deployed function — safe to remove once
confirmed nothing else needs them.
Deno-specific ports live at `supabase/functions/<name>/index.ts` in the CLI
scratch workspace used to deploy them; `app/functions/*.js` remain the
Node-flavored source-of-truth versions these were ported from, kept in sync
by hand — if you edit one, mirror the change in the other.

- **`generate`** — now Gemini-backed (switched from Higgsfield, 2026-07-06 —
  see the `generate.js` file-map entry above for the full story), auto-chains
  the checker, proven live end-to-end: `generated:1, checked:1`, real verdict
  attached, on two real and very different products. Wired to
  `5-scenes-editor.html`'s "Generate & check these scenes now →" button,
  which now also calls `expand-shots` first (see below) — the whole middle
  of the pipeline runs from that one click.
- **`ai-draft`** — proven live: a real `kind:'copy'` call returned genuine
  on-brand copy options. Wired to `4-tags-editor.html` (`kind:'tags'`) and
  `5-scenes-editor.html` (`kind:'scenes'`, batch size passed explicitly from
  the live input so a just-typed number isn't lost to a race with its save,
  and the result is hard-truncated to that count since "count = N" in the
  prompt is a request the model can overshoot). NOT yet wired to a
  `kind:'copy'` button — that lives on the not-yet-built Compose page.
- **`expand-shots`** — wired and live-tested (2026-07-06), last of the four
  functions to get connected, per the Owner's stated order (wire → checker →
  expand). No longer has its own button — `5-scenes-editor.html`'s
  "Generate & check" CTA calls it silently first, before `generate` (Owner
  call: the shot-expansion machinery should be invisible; the Scenes list
  IS the shot list from the user's point of view). Also fixed to strip a "*"
  owner-written marker (see the scenes-editor entry below) before building
  prompts, so it never leaks into a generation prompt — verified live.
- **`checker`** — proven live and wired to `6-checker-gallery.html` (manual
  "▶ Run checker" per-render, for anything the auto-chain above didn't
  already score — e.g. renders from before this change, or a re-check after
  a correction) AND inlined into `generate`'s auto-chain. Builds a `spec`
  from the project's weighted tags (`buildSpecFromTags()` — must → reject
  severity, should → flag severity, flavor → left out entirely, matching
  the weight semantics already documented in `ai-draft.js`'s tags prompt).
  Live-tested twice against real renders: both times correctly caught the
  same real defect (door closed vs. the required open state) with a real
  reason string from Claude vision, not a canned response.
- **`projects.reference_image`** (real column, added 2026-07-06 — was
  briefly a `settings.reference_image` hack during the first checker-wiring
  pass, since promoted to a proper column once it was clear this is a
  permanent, load-bearing concept, not a guess) — path into the `projects`
  storage bucket pointing at the real product reference photo, set at
  project creation via the new-project modal (see `2-project-list.html`
  above) or by hand for projects created before that modal existed.
- **`lib/functions.js`** — shared browser helper (`callFunction(name, body)`
  forwards the signed-in Owner's JWT so Edge Functions see the same RLS
  scope as any other `db.js` call; `withBusy(button, statusEl, label, fn)`
  is the shared "generating…" affordance — disables the button, shows the
  label, and clears the status note the moment the call settles, success or
  failure, per the Owner's brief that these notes shouldn't linger).

## What's still a TODO

3. **spec.json has no schema home.** `001_init.sql`'s `projects` table has no
   `spec` column, but `spec-checker/run_checker.py` needs a per-project spec
   (product checklist + severities) to run stage 2. `functions/checker.js`
   takes `spec` as a caller-supplied parameter rather than inventing a
   column. **Ask the Owner**: add a `projects.spec jsonb` column, or store it
   elsewhere? Flagging rather than guessing on a schema change.
4. **Stage 1 (code checks: resolution/sharpness/color) not ported.**
   `check_stage1.py` needs an image-processing library; no JS equivalent was
   chosen. Only stage 2 (vision compare) is ported in `functions/checker.js`.
5. **No render upload UI built yet.** `lib/db.js` has `uploadFile()` /
   `getSignedUrl()` helpers for the `projects` storage bucket, but no screen
   drag-drops files in. Renders currently have to be inserted into the
   `renders` table + storage bucket by hand (e.g. via the Supabase dashboard)
   to test the checker/review screens end-to-end.
6. **Zip download not wired.** `server.py`'s `GET /zip` has no hosted port —
   `7-review-gallery.html`'s "Download all as zip" button shows an alert().
   Needs either a small server-side zip function or a client-side JS-zip
   library pulling each signed URL.
7. **Client favorites/comments are localStorage-only**, not synced anywhere
   the Owner can see them. `renders` has no `favorite`/`comment` columns.
   Ask the Owner: new columns on `renders`, or a separate
   `client_feedback` table?
8. ~~No "new project" flow wired.~~ **DONE (2026-07-06).** The ＋ New project
   button on `2-project-list.html` opens a real modal: pick/create a client
   (`db.createClient()`), name the campaign, upload 1+ reference photos
   (written to storage + `projects.reference_image`), then redirects to
   the Tags editor. Live-tested end-to-end (create client → create project →
   upload → set reference_image → cleanup) before being left in the UI.
9. **No client login screen** — per `design/design-notes.md`, this was
   intentionally out of Min's scope. `7-review-gallery.html` assumes the
   visitor already has a Supabase Auth session tied to `client_users`; if
   they don't, RLS returns zero rows and the page shows a "nothing to show /
   sign in" message rather than erroring. A dedicated client-login UI is
   still open.

## Things guessed at (flagging for Owner sign-off, not silently decided)

- **`projects.shots` jsonb shape.** Not specified in `001_init.sql` beyond
  "expanded shots table (generated, never hand-edited)". Implemented as
  `{ product_lock, style_lock, items: [{index, file, motif, prompt}] }` to
  match the columns shown in `design/5-scenes-editor.html`'s expanded-shots
  table. This is a new contract (no server.py equivalent — the old pipeline
  did this expansion in a manual Claude chat), so it's worth a second look
  before more code depends on the shape.
- **File-slug naming** in `expand-shots.js` (`<product>-<motif-slug>-<NN>`)
  is invented to match the pattern seen in existing project folders (e.g.
  `crate-blue-living-01`) — not specified anywhere as a contract.
