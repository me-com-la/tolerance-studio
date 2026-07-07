-- Tolerance Studio — initial schema
-- Apply to the new `tolerance-studio` Supabase project (blocked on org Pro upgrade, see ../saas-plan.md).
-- Mirrors the folder pipeline: clients/<Client>/<dated project>/ with tags.json,
-- prompts.md (scenes + expanded shots), renders, checker verdicts, copy, review, delivery.

-- ---------- roles ----------
-- Owner = full pipeline. Client users = review gallery + downloads for their client only.
create table owners (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,          -- storage path prefix, e.g. 'kindtail'
  created_at timestamptz not null default now()
);

create table client_users (
  user_id uuid references auth.users (id) on delete cascade,
  client_id uuid references clients (id) on delete cascade,
  primary key (user_id, client_id)
);

-- ---------- pipeline ----------
-- One project = one product (Owner rule). tags.json is the brief (brief.md retired 2026-07-06).
create table projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  name text not null,                 -- campaign, e.g. 'Vase 257'
  started_on date not null default current_date,
  product text,
  description text,
  status text not null default 'brief'
    check (status in ('brief','generating','checking','compose','review','delivered')),
  tags jsonb,                         -- weighted tag cloud {product:[{t,w}],creative:[{t,w}]}
  scenes text,                        -- editable Scenes list (numbered short phrases)
  shots jsonb,                        -- expanded shots table (generated, never hand-edited)
  copy_options jsonb,                 -- [{eyebrow,headline,body,cta} x5]
  reference_image text,               -- path in the 'projects' bucket to the real product
                                       -- photo (1-3 uploaded at project creation, mirrors the
                                       -- old tool's "1-Client-Assets" step) — used by the
                                       -- checker as ground truth. Added 2026-07-06, after
                                       -- the first checker wiring pass revealed nothing else
                                       -- told the checker what to compare against.
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (client_id, name, started_on)
);

create table renders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  filename text not null,
  storage_path text not null,         -- path in the 'projects' bucket
  stage text not null default 'render'
    check (stage in ('render','composed','review','delivered')),
  checker jsonb,                      -- stage1 + stage2 results
  verdict text check (verdict in ('approved','rejected')),          -- checker's call
  human_override text check (human_override in ('approved','rejected')),
  -- Owner override is final and sticky: checker reruns must never change a row
  -- where human_override is set (enforced in the checker function, not here).
  created_at timestamptz not null default now(),
  unique (project_id, filename)
);

create table run_log (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects (id) on delete cascade,
  step text not null,                 -- tags-draft | scenes-draft | expand | check | compose | deliver
  note text,
  created_at timestamptz not null default now()
);

-- ---------- row-level security ----------
alter table owners enable row level security;
alter table clients enable row level security;
alter table client_users enable row level security;
alter table projects enable row level security;
alter table renders enable row level security;
alter table run_log enable row level security;

create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from owners where user_id = auth.uid()) $$;

create or replace function my_client_ids() returns setof uuid
language sql stable security definer set search_path = public as
$$ select client_id from client_users where user_id = auth.uid() $$;

-- Owner: full access everywhere.
create policy owner_all_owners  on owners  for all using (is_owner()) with check (is_owner());
create policy owner_all_clients on clients for all using (is_owner()) with check (is_owner());
create policy owner_all_cu      on client_users for all using (is_owner()) with check (is_owner());
create policy owner_all_projects on projects for all using (is_owner()) with check (is_owner());
create policy owner_all_renders on renders for all using (is_owner()) with check (is_owner());
create policy owner_all_runlog  on run_log for all using (is_owner()) with check (is_owner());

-- Client users: read-only, their client only, and only work that has reached review.
create policy client_read_clients on clients for select
  using (id in (select my_client_ids()));
create policy client_read_projects on projects for select
  using (client_id in (select my_client_ids()) and status in ('review','delivered'));
create policy client_read_renders on renders for select
  using (
    stage in ('review','delivered')
    and project_id in (
      select id from projects
      where client_id in (select my_client_ids()) and status in ('review','delivered')
    )
  );

-- ---------- storage ----------
-- Single private bucket; paths: <client-slug>/<project-id>/<area>/<file>
-- areas: assets | renders | composed | review | delivery
insert into storage.buckets (id, name, public) values ('projects', 'projects', false);

create policy owner_storage_all on storage.objects for all
  using (bucket_id = 'projects' and is_owner())
  with check (bucket_id = 'projects' and is_owner());

-- Clients download only review/delivery files under their own slug.
create policy client_storage_read on storage.objects for select
  using (
    bucket_id = 'projects'
    and (storage.foldername(name))[1] in (select slug from clients where id in (select my_client_ids()))
    and (storage.foldername(name))[3] in ('review','delivery')
  );
