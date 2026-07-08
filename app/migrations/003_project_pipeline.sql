-- 003 — project pipeline: tag every project with which app created it.
-- Standard (app/app) and Pro (app/pro) share this one Supabase project (merged
-- 2026-07-08) but write to the same `projects` table with no column telling
-- them apart, so 2-project-list.html shows every project on both apps,
-- distinguishable only by the page's own top-bar logo. This column fixes that.
alter table projects add column if not exists pipeline text
  not null default 'standard' check (pipeline in ('standard','pro'));

-- Backfill: at merge time (2026-07-08) Pro's frontend still pointed at its own
-- separate (now-retired) Supabase project, so every row that already exists
-- in this merged DB was created via app/app — safe to default them all to
-- 'standard' rather than guess.
update projects set pipeline = 'standard' where pipeline is null;
