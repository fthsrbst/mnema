-- Mnema Cloud control/data-plane foundation for Supabase Postgres.
-- Self-hosted Mnema keeps SQLite as its authority; this schema is cloud-only.

create schema if not exists app;

create or replace function app.current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index if not exists organization_members_user_idx
  on public.organization_members(user_id, organization_id);

create or replace function app.create_organization(organization_slug text, organization_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_id uuid;
  actor_id uuid := app.current_user_id();
begin
  if actor_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  insert into public.organizations(slug, name, created_by)
    values (organization_slug, organization_name, actor_id)
    returning id into new_id;
  insert into public.organization_members(organization_id, user_id, role)
    values (new_id, actor_id, 'owner');
  return new_id;
end
$$;

create or replace function app.is_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.organization_members member
    where member.organization_id = target_organization_id
      and member.user_id = app.current_user_id()
  )
$$;

create or replace function app.has_organization_role(target_organization_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.organization_members member
    where member.organization_id = target_organization_id
      and member.user_id = app.current_user_id()
      and member.role = any(allowed_roles)
  )
$$;

revoke all on function app.is_organization_member(uuid) from public;
revoke all on function app.has_organization_role(uuid, text[]) from public;
grant execute on function app.is_organization_member(uuid) to authenticated;
grant execute on function app.has_organization_role(uuid, text[]) to authenticated;
revoke all on function app.create_organization(text, text) from public;
grant execute on function app.create_organization(text, text) to authenticated;

create table if not exists public.projects (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  map jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, slug)
);

create table if not exists public.memories (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  project_id uuid,
  type text not null default 'fact',
  title text not null,
  body text not null,
  tags text[] not null default '{}',
  importance real not null default 1 check (importance between 0 and 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  foreign key (organization_id, project_id)
    references public.projects(organization_id, id) on delete cascade
);
create index if not exists memories_tenant_project_idx
  on public.memories(organization_id, project_id, updated_at desc);

create table if not exists public.documents (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  project_id uuid,
  uri text,
  title text not null,
  source text,
  kind text not null default 'reference',
  is_current boolean not null default true,
  content_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, uri),
  foreign key (organization_id, project_id)
    references public.projects(organization_id, id) on delete cascade
);

create table if not exists public.document_chunks (
  organization_id uuid not null,
  document_id uuid not null,
  id uuid not null default gen_random_uuid(),
  sequence integer not null check (sequence >= 0),
  heading text,
  content text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, document_id, sequence),
  foreign key (organization_id, document_id)
    references public.documents(organization_id, id) on delete cascade
);

create table if not exists public.session_logs (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  project_id uuid,
  summary text not null,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  foreign key (organization_id, project_id)
    references public.projects(organization_id, id) on delete cascade
);

create table if not exists public.memory_relations (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  from_memory_id uuid not null,
  to_memory_id uuid not null,
  relation_type text not null,
  confidence real not null default 1 check (confidence between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  foreign key (organization_id, from_memory_id)
    references public.memories(organization_id, id) on delete cascade,
  foreign key (organization_id, to_memory_id)
    references public.memories(organization_id, id) on delete cascade,
  check (from_memory_id <> to_memory_id)
);

-- Server-owned billing records. No authenticated-user policy is created:
-- clients read entitlements through a narrow server endpoint, while verified
-- webhooks write with the service role.
create table if not exists public.billing_customers (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('paddle', 'lemonsqueezy')),
  provider_customer_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_customer_id)
);

create table if not exists public.subscriptions (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('paddle', 'lemonsqueezy')),
  provider_subscription_id text not null,
  plan text not null check (plan in ('free', 'starter', 'pro', 'team')),
  status text not null check (status in ('trialing', 'active', 'past_due', 'paused', 'canceled')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  last_event_id text not null,
  last_event_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);

create table if not exists public.billing_webhook_events (
  provider text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  payload_sha256 text not null,
  error_code text,
  primary key (provider, event_id)
);

create table if not exists public.audit_events (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id bigint generated always as identity,
  actor_user_id uuid references auth.users(id),
  action text not null,
  resource_type text,
  resource_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (organization_id, id)
);

-- Every tenant-owned table is both RLS-enabled and forced. FORCE protects
-- against accidental access through table-owner application connections.
alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.organizations enable row level security;
alter table public.organizations force row level security;
alter table public.organization_members enable row level security;
alter table public.organization_members force row level security;
alter table public.projects enable row level security;
alter table public.projects force row level security;
alter table public.memories enable row level security;
alter table public.memories force row level security;
alter table public.documents enable row level security;
alter table public.documents force row level security;
alter table public.document_chunks enable row level security;
alter table public.document_chunks force row level security;
alter table public.session_logs enable row level security;
alter table public.session_logs force row level security;
alter table public.memory_relations enable row level security;
alter table public.memory_relations force row level security;
alter table public.billing_customers enable row level security;
alter table public.billing_customers force row level security;
alter table public.subscriptions enable row level security;
alter table public.subscriptions force row level security;
alter table public.billing_webhook_events enable row level security;
alter table public.billing_webhook_events force row level security;
alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;

create policy profiles_self_select on public.profiles
  for select to authenticated using (id = app.current_user_id());
create policy profiles_self_update on public.profiles
  for update to authenticated using (id = app.current_user_id()) with check (id = app.current_user_id());

create policy organizations_member_select on public.organizations
  for select to authenticated using (app.is_organization_member(id));
create policy organizations_owner_update on public.organizations
  for update to authenticated
  using (app.has_organization_role(id, array['owner']))
  with check (app.has_organization_role(id, array['owner']));

create policy organization_members_member_select on public.organization_members
  for select to authenticated using (app.is_organization_member(organization_id));
create policy organization_members_admin_insert on public.organization_members
  for insert to authenticated
  with check (app.has_organization_role(organization_id, array['owner', 'admin']));
create policy organization_members_admin_update on public.organization_members
  for update to authenticated
  using (app.has_organization_role(organization_id, array['owner', 'admin']))
  with check (app.has_organization_role(organization_id, array['owner', 'admin']));
create policy organization_members_admin_delete on public.organization_members
  for delete to authenticated
  using (app.has_organization_role(organization_id, array['owner', 'admin']));

-- Repeatable data-table policies. Reads require membership; writes require an
-- owner/admin/member role. Tenant ids are checked on both old and new rows.
create policy projects_member_select on public.projects
  for select to authenticated using (app.is_organization_member(organization_id));
create policy projects_member_insert on public.projects
  for insert to authenticated with check (app.has_organization_role(organization_id, array['owner','admin','member']));
create policy projects_member_update on public.projects
  for update to authenticated using (app.has_organization_role(organization_id, array['owner','admin','member']))
  with check (app.has_organization_role(organization_id, array['owner','admin','member']));
create policy projects_member_delete on public.projects
  for delete to authenticated using (app.has_organization_role(organization_id, array['owner','admin','member']));

create policy memories_member_select on public.memories
  for select to authenticated using (app.is_organization_member(organization_id));
create policy memories_member_insert on public.memories
  for insert to authenticated with check (app.has_organization_role(organization_id, array['owner','admin','member']));
create policy memories_member_update on public.memories
  for update to authenticated using (app.has_organization_role(organization_id, array['owner','admin','member']))
  with check (app.has_organization_role(organization_id, array['owner','admin','member']));
create policy memories_member_delete on public.memories
  for delete to authenticated using (app.has_organization_role(organization_id, array['owner','admin','member']));

create policy documents_member_select on public.documents
  for select to authenticated using (app.is_organization_member(organization_id));
create policy documents_member_insert on public.documents
  for insert to authenticated with check (app.has_organization_role(organization_id, array['owner','admin','member']));
create policy documents_member_update on public.documents
  for update to authenticated using (app.has_organization_role(organization_id, array['owner','admin','member']))
  with check (app.has_organization_role(organization_id, array['owner','admin','member']));
create policy documents_member_delete on public.documents
  for delete to authenticated using (app.has_organization_role(organization_id, array['owner','admin','member']));

create policy document_chunks_member_select on public.document_chunks
  for select to authenticated using (app.is_organization_member(organization_id));
create policy document_chunks_member_insert on public.document_chunks
  for insert to authenticated with check (app.has_organization_role(organization_id, array['owner','admin','member']));
create policy document_chunks_member_update on public.document_chunks
  for update to authenticated using (app.has_organization_role(organization_id, array['owner','admin','member']))
  with check (app.has_organization_role(organization_id, array['owner','admin','member']));
create policy document_chunks_member_delete on public.document_chunks
  for delete to authenticated using (app.has_organization_role(organization_id, array['owner','admin','member']));

create policy session_logs_member_select on public.session_logs
  for select to authenticated using (app.is_organization_member(organization_id));
create policy session_logs_member_insert on public.session_logs
  for insert to authenticated with check (app.has_organization_role(organization_id, array['owner','admin','member']));
create policy session_logs_member_update on public.session_logs
  for update to authenticated using (app.has_organization_role(organization_id, array['owner','admin','member']))
  with check (app.has_organization_role(organization_id, array['owner','admin','member']));
create policy session_logs_member_delete on public.session_logs
  for delete to authenticated using (app.has_organization_role(organization_id, array['owner','admin','member']));

create policy memory_relations_member_select on public.memory_relations
  for select to authenticated using (app.is_organization_member(organization_id));
create policy memory_relations_member_insert on public.memory_relations
  for insert to authenticated with check (app.has_organization_role(organization_id, array['owner','admin','member']));
create policy memory_relations_member_update on public.memory_relations
  for update to authenticated using (app.has_organization_role(organization_id, array['owner','admin','member']))
  with check (app.has_organization_role(organization_id, array['owner','admin','member']));
create policy memory_relations_member_delete on public.memory_relations
  for delete to authenticated using (app.has_organization_role(organization_id, array['owner','admin','member']));

create policy audit_events_member_select on public.audit_events
  for select to authenticated using (app.is_organization_member(organization_id));

grant usage on schema public, app to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, update on public.organizations to authenticated;
grant select, insert, update, delete on public.organization_members to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.memories to authenticated;
grant select, insert, update, delete on public.documents to authenticated;
grant select, insert, update, delete on public.document_chunks to authenticated;
grant select, insert, update, delete on public.session_logs to authenticated;
grant select, insert, update, delete on public.memory_relations to authenticated;
grant select on public.audit_events to authenticated;

-- Intentionally no authenticated grants for billing_customers, subscriptions,
-- or billing_webhook_events. Those tables are service-role only.
