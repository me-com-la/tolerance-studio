-- 008: record which image model produced each render (2026-07-20, Owner ask).
-- Written by the generate function (default/seedream/gpt/bria), the Exact
-- pipeline on the Scenes page ('exact'), and the Fix-now edit flow ('edit').
-- Old rows stay null — shown without a badge rather than guessed.
alter table renders add column if not exists model text;
