-- 004 — favorites: a user can mark any of their own renders as a favorite,
-- independent of pipeline stage (previously the closest concept was
-- stage='composed', which conflated "finished with text on it" with "the
-- ones I actually want to keep"). Powers the heart icon in my-images.html
-- (Files) and inside the Standard/Pro apps.
--
-- No new RLS policy needed — member_all_renders (002_beta_members.sql) and
-- owner_all_renders (001_init.sql) are both `for all`, so they already cover
-- UPDATE on this column.
alter table renders add column if not exists is_favorite boolean not null default false;
