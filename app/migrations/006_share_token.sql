-- 006_share_token.sql — public client review links (2026-07-15).
--
-- Problem this solves: 7-review-gallery.html reads images through the
-- authenticated Supabase client, so RLS only ever hands them to the Owner or
-- a registered client_user. A real client opening the emailed link (no
-- account, and usually inside a mail app's in-app browser with no session)
-- sees nothing. See lib comments in 7-review-gallery.html wireEmailLinkButton.
--
-- Fix: each project carries a random share token. The review-view Edge
-- Function (service role, deployed with verify_jwt = false) validates the
-- token and returns signed image URLs, so a client opens review.html?t=<token>
-- with no login. RLS below is UNTOUCHED — anon still reads nothing directly;
-- every shared view goes through the function, which only exposes projects
-- already at 'review'/'delivered' stage. Rotating the token revokes old links.
alter table projects
  add column if not exists share_token uuid not null default gen_random_uuid();

create unique index if not exists projects_share_token_idx on projects(share_token);
