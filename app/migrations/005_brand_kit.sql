-- Brand kit (2026-07-11): one jsonb blob per client holding brand defaults
-- that survive across projects — shape { tags, font, text_color, cta_color,
-- text_size }. A column on clients (not a new table) so it inherits the
-- existing RLS: owner_all_clients gives the Owner read/write, clients'
-- read-only select policy exposes it harmlessly.
alter table public.clients add column if not exists brand_kit jsonb;
