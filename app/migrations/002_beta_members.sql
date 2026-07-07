-- 002 — beta members: self-serve signups get their own workspace + entitlements.
-- Owner (owners table) keeps full super-admin access via existing is_owner() policies.
-- A member's workspace = clients rows where owner_id = their auth uid.
-- Pre-existing clients keep owner_id null (Owner-managed; invisible to members).

-- default auth.uid(): the app's existing db.createClient() inserts {name,slug}
-- only; without the default, the member insert policy's with-check would reject it.
alter table clients add column if not exists owner_id uuid references auth.users (id) on delete cascade default auth.uid();

create or replace function my_owned_client_ids() returns setof uuid
language sql stable security definer set search_path = public as
$$ select id from clients where owner_id = auth.uid() $$;

-- Members: full control of their own clients + everything hanging off them.
create policy member_all_clients on clients for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy member_all_projects on projects for all
  using (client_id in (select my_owned_client_ids()))
  with check (client_id in (select my_owned_client_ids()));
create policy member_all_renders on renders for all
  using (project_id in (select id from projects where client_id in (select my_owned_client_ids())))
  with check (project_id in (select id from projects where client_id in (select my_owned_client_ids())));
create policy member_all_runlog on run_log for all
  using (project_id in (select id from projects where client_id in (select my_owned_client_ids())))
  with check (project_id in (select id from projects where client_id in (select my_owned_client_ids())));

-- Storage: members read/write under their own client slugs only.
create policy member_storage_all on storage.objects for all
  using (
    bucket_id = 'projects'
    and (storage.foldername(name))[1] in (select slug from clients where owner_id = auth.uid())
  )
  with check (
    bucket_id = 'projects'
    and (storage.foldername(name))[1] in (select slug from clients where owner_id = auth.uid())
  );

-- ---------- entitlements ----------
create table if not exists entitlements (
  user_id uuid not null references auth.users (id) on delete cascade,
  product text not null check (product in ('standard','pro')),
  status text not null default 'beta-free',
  created_at timestamptz not null default now(),
  primary key (user_id, product)
);

alter table entitlements enable row level security;
create policy owner_all_entitlements on entitlements for all
  using (is_owner()) with check (is_owner());
create policy member_read_entitlements on entitlements for select
  using (user_id = auth.uid());

-- Free beta: every new signup gets both products.
create or replace function grant_beta_entitlements() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into entitlements (user_id, product) values (new.id, 'standard'), (new.id, 'pro')
  on conflict do nothing;
  return new;
end $$;

-- Backfill users created before this trigger existed.
insert into entitlements (user_id, product)
select u.id, p.product from auth.users u cross join (values ('standard'),('pro')) p(product)
on conflict do nothing;

drop trigger if exists on_auth_user_created_grant_beta on auth.users;
create trigger on_auth_user_created_grant_beta
  after insert on auth.users
  for each row execute function grant_beta_entitlements();
