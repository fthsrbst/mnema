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

create or replace function app.current_user_email()
returns text
language sql
stable
as $$
  select lower(nullif(current_setting('request.jwt.claim.email', true), ''))
$$;

create or replace function app.current_aal()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.aal', true), ''), 'aal1')
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
  created_by uuid references auth.users(id) on delete set null,
  deletion_requested_at timestamptz,
  deletion_scheduled_for timestamptz,
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

create table if not exists public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role text not null check (role in ('admin', 'member', 'viewer')),
  invited_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists organization_invitations_pending_email_idx
  on public.organization_invitations(organization_id, email) where status = 'pending';
create index if not exists organization_invitations_email_idx
  on public.organization_invitations(email, expires_at desc) where status = 'pending';

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
    join public.organizations organization on organization.id = member.organization_id
    where member.organization_id = target_organization_id
      and member.user_id = app.current_user_id()
      and member.role = any(allowed_roles)
      and organization.deletion_scheduled_for is null
  )
$$;

create or replace function app.organization_accepts_writes(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.organizations organization
    where organization.id = target_organization_id
      and organization.deletion_scheduled_for is null
  )
$$;

revoke all on function app.is_organization_member(uuid) from public;
revoke all on function app.has_organization_role(uuid, text[]) from public;
revoke all on function app.organization_accepts_writes(uuid) from public;
grant execute on function app.is_organization_member(uuid) to authenticated;
grant execute on function app.has_organization_role(uuid, text[]) to authenticated;
grant execute on function app.organization_accepts_writes(uuid) to authenticated;
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
create index if not exists memories_search_idx
  on public.memories using gin (to_tsvector('simple', title || ' ' || body));

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
create index if not exists document_chunks_search_idx
  on public.document_chunks using gin (to_tsvector('simple', coalesce(heading, '') || ' ' || content));

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
  claimed_at timestamptz not null default now(),
  attempts integer not null default 1 check (attempts > 0),
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  payload_sha256 text not null,
  error_code text,
  primary key (provider, event_id)
);

create table if not exists public.audit_events (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id bigint generated always as identity,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  resource_type text,
  resource_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (organization_id, id)
);

-- Provider retries after a transient failure must be processable, while a
-- concurrent duplicate or an already-completed event must not run twice.
create or replace function app.claim_billing_webhook(
  provider_name text,
  provider_event_id text,
  body_sha256 text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.billing_webhook_events%rowtype;
  claimed boolean := false;
begin
  insert into public.billing_webhook_events(provider, event_id, payload_sha256)
    values (provider_name, provider_event_id, body_sha256)
    on conflict (provider, event_id) do nothing;
  if found then return true; end if;

  select * into existing from public.billing_webhook_events
    where provider = provider_name and event_id = provider_event_id
    for update;
  if existing.payload_sha256 <> body_sha256 then
    raise exception 'webhook event payload hash mismatch' using errcode = '22000';
  end if;
  if existing.status in ('processed', 'ignored') then return false; end if;
  if existing.status = 'failed' or existing.claimed_at < now() - interval '5 minutes' then
    update public.billing_webhook_events
      set status = 'received', claimed_at = now(), attempts = attempts + 1,
          processed_at = null, error_code = null
      where provider = provider_name and event_id = provider_event_id;
    claimed := true;
  end if;
  return claimed;
end
$$;
revoke all on function app.claim_billing_webhook(text, text, text) from public;
grant usage on schema app to service_role;
grant execute on function app.claim_billing_webhook(text, text, text) to service_role;

create or replace function app.apply_subscription_snapshot(
  target_organization_id uuid,
  provider_name text,
  subscription_id text,
  plan_name text,
  subscription_status text,
  period_end timestamptz,
  cancels_at_period_end boolean,
  provider_event_id text,
  provider_event_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  subscription_applied boolean := false;
begin
  perform 1 from public.organizations where id = target_organization_id for update;
  if not found then
    raise exception 'organization not found' using errcode = '22023';
  end if;
  insert into public.subscriptions(
    organization_id, provider, provider_subscription_id, plan, status,
    current_period_end, cancel_at_period_end, last_event_id, last_event_at
  ) values (
    target_organization_id, provider_name, subscription_id, plan_name,
    subscription_status, period_end, cancels_at_period_end,
    provider_event_id, provider_event_at
  )
  on conflict (organization_id) do update set
    provider = excluded.provider,
    provider_subscription_id = excluded.provider_subscription_id,
    plan = excluded.plan,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    last_event_id = excluded.last_event_id,
    last_event_at = excluded.last_event_at,
    updated_at = now()
  where public.subscriptions.last_event_at < excluded.last_event_at
  returning true into subscription_applied;
  return coalesce(subscription_applied, false);
end
$$;
revoke all on function app.apply_subscription_snapshot(uuid, text, text, text, text, timestamptz, boolean, text, timestamptz) from public;
grant execute on function app.apply_subscription_snapshot(uuid, text, text, text, text, timestamptz, boolean, text, timestamptz) to service_role;

-- Writes that affect billable limits go through transaction-scoped RPCs.
-- Locking the organization row serializes concurrent quota checks, so two
-- requests cannot both observe the same remaining slot and over-allocate it.
create or replace function app.active_plan(target_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select subscription.plan
    from public.subscriptions subscription
    where subscription.organization_id = target_organization_id
      and subscription.status in ('trialing', 'active', 'past_due')
    limit 1
  ), 'free')
$$;

create or replace function app.create_organization_invitation(
  target_organization_id uuid,
  invitee_email text,
  invitee_role text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := app.current_user_id();
  normalized_email text := lower(trim(invitee_email));
  invitation_id uuid;
  invitation_expires_at timestamptz;
  member_limit integer;
begin
  if app.current_aal() <> 'aal2' then
    raise exception 'MFA required' using errcode = '42501', detail = 'mfa_required';
  end if;
  if invitee_role not in ('admin','member','viewer') then
    raise exception 'invalid invitation role' using errcode = '22023';
  end if;
  if not app.has_organization_role(target_organization_id, array['owner','admin']) then
    raise exception 'insufficient organization role' using errcode = '42501';
  end if;
  if not app.organization_accepts_writes(target_organization_id) then
    raise exception 'organization deletion is scheduled' using errcode = '55000';
  end if;
  if invitee_role = 'admin' and not app.has_organization_role(target_organization_id, array['owner']) then
    raise exception 'only owners may invite admins' using errcode = '42501';
  end if;
  if normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid invitation email' using errcode = '22023';
  end if;
  perform 1 from public.organizations where id = target_organization_id for update;
  member_limit := case app.active_plan(target_organization_id)
    when 'pro' then 3
    when 'team' then 10
    else 1
  end;
  if exists (
    select 1 from public.organization_members member
    join auth.users account on account.id = member.user_id
    where member.organization_id = target_organization_id and lower(account.email) = normalized_email
  ) then
    raise exception 'user is already a member' using errcode = '23505', detail = 'already_member';
  end if;
  select invitation.id, invitation.expires_at into invitation_id, invitation_expires_at
    from public.organization_invitations invitation
    where invitation.organization_id = target_organization_id
      and invitation.email = normalized_email and invitation.status = 'pending'
    for update;
  if invitation_id is not null then
    if invitation_expires_at <= now() and (
      (select count(*) from public.organization_members where organization_id = target_organization_id)
      + (select count(*) from public.organization_invitations where organization_id = target_organization_id and status = 'pending' and expires_at > now())
    ) >= member_limit then
      raise exception 'member quota exceeded' using errcode = 'P0001', detail = 'member_quota_exceeded';
    end if;
    update public.organization_invitations
      set role = invitee_role, invited_by = actor_id, expires_at = now() + interval '7 days',
          revoked_at = null, updated_at = now()
      where id = invitation_id;
    return invitation_id;
  end if;
  if (
    (select count(*) from public.organization_members where organization_id = target_organization_id)
    + (select count(*) from public.organization_invitations where organization_id = target_organization_id and status = 'pending' and expires_at > now())
  ) >= member_limit then
    raise exception 'member quota exceeded' using errcode = 'P0001', detail = 'member_quota_exceeded';
  end if;
  insert into public.organization_invitations(organization_id, email, role, invited_by)
    values (target_organization_id, normalized_email, invitee_role, actor_id)
    returning id into invitation_id;
  return invitation_id;
end
$$;

create or replace function app.list_my_organization_invitations()
returns table(invitation_id uuid, organization_id uuid, organization_name text, organization_slug text, invitation_role text, expires_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select invitation.id, invitation.organization_id, organization.name, organization.slug, invitation.role, invitation.expires_at
  from public.organization_invitations invitation
  join public.organizations organization on organization.id = invitation.organization_id
  where invitation.email = app.current_user_email()
    and invitation.status = 'pending' and invitation.expires_at > now()
  order by invitation.created_at desc
$$;

create or replace function app.list_organization_invitations(target_organization_id uuid)
returns table(invitation_id uuid, email text, invitation_role text, invitation_status text, expires_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_aal() <> 'aal2' or not app.has_organization_role(target_organization_id, array['owner','admin']) then
    raise exception 'insufficient organization role' using errcode = '42501';
  end if;
  return query
    select invitation.id, invitation.email, invitation.role, invitation.status, invitation.expires_at
    from public.organization_invitations invitation
    where invitation.organization_id = target_organization_id
    order by invitation.created_at desc limit 100;
end
$$;

create or replace function app.accept_organization_invitation(target_invitation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  invitation public.organization_invitations%rowtype;
  member_limit integer;
begin
  select * into invitation from public.organization_invitations
    where id = target_invitation_id for update;
  if invitation.id is null or invitation.status <> 'pending' or invitation.expires_at <= now() then
    raise exception 'invitation is unavailable' using errcode = '22023';
  end if;
  if invitation.email <> app.current_user_email() then
    raise exception 'invitation email mismatch' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = invitation.organization_id for update;
  if not app.organization_accepts_writes(invitation.organization_id) then
    raise exception 'organization deletion is scheduled' using errcode = '55000';
  end if;
  member_limit := case app.active_plan(invitation.organization_id)
    when 'pro' then 3
    when 'team' then 10
    else 1
  end;
  if (select count(*) from public.organization_members where organization_id = invitation.organization_id) >= member_limit then
    raise exception 'member quota exceeded' using errcode = 'P0001', detail = 'member_quota_exceeded';
  end if;
  insert into public.organization_members(organization_id, user_id, role)
    values (invitation.organization_id, app.current_user_id(), invitation.role)
    on conflict (organization_id, user_id) do nothing;
  update public.organization_invitations
    set status = 'accepted', accepted_by = app.current_user_id(), accepted_at = now(), updated_at = now()
    where id = invitation.id;
  return invitation.organization_id;
end
$$;

create or replace function app.revoke_organization_invitation(target_organization_id uuid, target_invitation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_aal() <> 'aal2' or not app.has_organization_role(target_organization_id, array['owner','admin']) then
    raise exception 'insufficient organization role' using errcode = '42501';
  end if;
  if not app.organization_accepts_writes(target_organization_id) then
    raise exception 'organization deletion is scheduled' using errcode = '55000';
  end if;
  update public.organization_invitations
    set status = 'revoked', revoked_at = now(), updated_at = now()
    where id = target_invitation_id and organization_id = target_organization_id and status = 'pending';
  return found;
end
$$;

create or replace function app.request_organization_deletion(
  target_organization_id uuid,
  confirmation_slug text
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  organization_slug text;
  deletion_time timestamptz := now() + interval '7 days';
  subscription public.subscriptions%rowtype;
begin
  if app.current_aal() <> 'aal2' or not app.has_organization_role(target_organization_id, array['owner']) then
    raise exception 'owner MFA required' using errcode = '42501';
  end if;
  select slug into organization_slug from public.organizations where id = target_organization_id for update;
  if organization_slug is null or confirmation_slug <> organization_slug then
    raise exception 'organization confirmation mismatch' using errcode = '22023';
  end if;
  select * into subscription from public.subscriptions where organization_id = target_organization_id;
  if subscription.status <> 'canceled' and not subscription.cancel_at_period_end then
    raise exception 'subscription must be canceled first' using errcode = 'P0001', detail = 'subscription_cancellation_required';
  end if;
  if subscription.current_period_end is not null then
    deletion_time := greatest(deletion_time, subscription.current_period_end);
  end if;
  update public.organizations
    set deletion_requested_at = now(), deletion_scheduled_for = deletion_time, updated_at = now()
    where id = target_organization_id;
  return deletion_time;
end
$$;

create or replace function app.cancel_organization_deletion(target_organization_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_aal() <> 'aal2' or not exists (
    select 1 from public.organization_members member
    where member.organization_id = target_organization_id
      and member.user_id = app.current_user_id()
      and member.role = 'owner'
  ) then
    raise exception 'owner MFA required' using errcode = '42501';
  end if;
  update public.organizations set deletion_requested_at = null, deletion_scheduled_for = null, updated_at = now()
    where id = target_organization_id and deletion_scheduled_for is not null;
  return found;
end
$$;

create or replace function app.list_organization_members(target_organization_id uuid)
returns table(member_user_id uuid, member_email text, member_role text, joined_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_aal() <> 'aal2' or not app.has_organization_role(target_organization_id, array['owner','admin']) then
    raise exception 'insufficient organization role' using errcode = '42501';
  end if;
  return query
    select member.user_id, lower(account.email), member.role, member.created_at
    from public.organization_members member
    join auth.users account on account.id = member.user_id
    where member.organization_id = target_organization_id
    order by member.created_at, member.user_id;
end
$$;

create or replace function app.change_organization_member_role(
  target_organization_id uuid,
  target_user_id uuid,
  target_role text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_aal() <> 'aal2' or not app.has_organization_role(target_organization_id, array['owner']) then
    raise exception 'owner MFA required' using errcode = '42501';
  end if;
  if not app.organization_accepts_writes(target_organization_id) then
    raise exception 'organization deletion is scheduled' using errcode = '55000';
  end if;
  if target_role not in ('owner','admin','member','viewer') then
    raise exception 'invalid member role' using errcode = '22023';
  end if;
  update public.organization_members
    set role = target_role
    where organization_id = target_organization_id and user_id = target_user_id;
  if not found then
    raise exception 'organization member not found' using errcode = '22023';
  end if;
  return true;
end
$$;

create or replace function app.remove_organization_member(
  target_organization_id uuid,
  target_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role text;
  removed_role text;
begin
  if app.current_aal() <> 'aal2' then
    raise exception 'MFA required' using errcode = '42501', detail = 'mfa_required';
  end if;
  if not app.organization_accepts_writes(target_organization_id) then
    raise exception 'organization deletion is scheduled' using errcode = '55000';
  end if;
  select member.role into actor_role from public.organization_members member
    where member.organization_id = target_organization_id and member.user_id = app.current_user_id();
  select member.role into removed_role from public.organization_members member
    where member.organization_id = target_organization_id and member.user_id = target_user_id;
  if actor_role not in ('owner','admin') or removed_role is null then
    raise exception 'insufficient organization role' using errcode = '42501';
  end if;
  if actor_role = 'admin' and removed_role in ('owner','admin') then
    raise exception 'admins cannot remove owners or admins' using errcode = '42501';
  end if;
  delete from public.organization_members
    where organization_id = target_organization_id and user_id = target_user_id;
  return found;
end
$$;

create or replace function app.assert_account_deletable(confirmation_email text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_aal() <> 'aal2' then
    raise exception 'MFA required' using errcode = '42501', detail = 'mfa_required';
  end if;
  if lower(trim(confirmation_email)) <> app.current_user_email() then
    raise exception 'account confirmation mismatch' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.organization_members
    where user_id = app.current_user_id() and role = 'owner'
  ) then
    raise exception 'owned organizations remain' using errcode = 'P0001', detail = 'owned_organizations_remain';
  end if;
  return true;
end
$$;

create or replace function app.purge_due_organizations(
  due_before timestamptz,
  batch_limit integer default 100
)
returns table(examined integer, purged integer, waiting_for_billing integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  safe_limit integer := least(greatest(batch_limit, 1), 500);
  due_count integer;
  waiting_count integer;
  purged_count integer;
begin
  select count(*)::integer,
         count(*) filter (where subscription.organization_id is not null and subscription.status <> 'canceled')::integer
    into due_count, waiting_count
    from public.organizations organization
    left join public.subscriptions subscription on subscription.organization_id = organization.id
    where organization.deletion_scheduled_for <= due_before;

  with candidates as materialized (
    select organization.id
    from public.organizations organization
    left join public.subscriptions subscription on subscription.organization_id = organization.id
    where organization.deletion_scheduled_for <= due_before
      and (subscription.organization_id is null or subscription.status = 'canceled')
    order by organization.deletion_scheduled_for, organization.id
    for update of organization skip locked
    limit safe_limit
  ),
  deleted as (
    delete from public.organizations organization
    using candidates
    where organization.id = candidates.id
    returning organization.id
  )
  select count(*)::integer into purged_count from deleted;

  return query select due_count, purged_count, waiting_count;
end
$$;

revoke all on function app.create_organization_invitation(uuid, text, text) from public;
revoke all on function app.list_my_organization_invitations() from public;
revoke all on function app.list_organization_invitations(uuid) from public;
revoke all on function app.accept_organization_invitation(uuid) from public;
revoke all on function app.revoke_organization_invitation(uuid, uuid) from public;
revoke all on function app.request_organization_deletion(uuid, text) from public;
revoke all on function app.cancel_organization_deletion(uuid) from public;
revoke all on function app.list_organization_members(uuid) from public;
revoke all on function app.change_organization_member_role(uuid, uuid, text) from public;
revoke all on function app.remove_organization_member(uuid, uuid) from public;
revoke all on function app.assert_account_deletable(text) from public;
revoke all on function app.purge_due_organizations(timestamptz, integer) from public;
grant execute on function app.create_organization_invitation(uuid, text, text) to authenticated;
grant execute on function app.list_my_organization_invitations() to authenticated;
grant execute on function app.list_organization_invitations(uuid) to authenticated;
grant execute on function app.accept_organization_invitation(uuid) to authenticated;
grant execute on function app.revoke_organization_invitation(uuid, uuid) to authenticated;
grant execute on function app.request_organization_deletion(uuid, text) to authenticated;
grant execute on function app.cancel_organization_deletion(uuid) to authenticated;
grant execute on function app.list_organization_members(uuid) to authenticated;
grant execute on function app.change_organization_member_role(uuid, uuid, text) to authenticated;
grant execute on function app.remove_organization_member(uuid, uuid) to authenticated;
grant execute on function app.assert_account_deletable(text) to authenticated;
grant execute on function app.purge_due_organizations(timestamptz, integer) to service_role;

create or replace function app.create_project(
  target_organization_id uuid,
  project_slug text,
  project_map jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_id uuid;
  project_limit integer;
begin
  if not app.has_organization_role(target_organization_id, array['owner','admin','member'])
     or not app.organization_accepts_writes(target_organization_id) then
    raise exception 'insufficient organization role' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = target_organization_id for update;
  project_limit := case app.active_plan(target_organization_id)
    when 'starter' then 10
    when 'pro' then 50
    when 'team' then 250
    else 2
  end;
  if (select count(*) from public.projects where organization_id = target_organization_id) >= project_limit then
    raise exception 'project quota exceeded' using errcode = 'P0001', detail = 'project_quota_exceeded';
  end if;
  insert into public.projects(organization_id, slug, map)
    values (target_organization_id, project_slug, coalesce(project_map, '{}'::jsonb))
    returning id into new_id;
  return new_id;
end
$$;

create or replace function app.add_memory(
  target_organization_id uuid,
  target_project_id uuid,
  memory_type text,
  memory_title text,
  memory_body text,
  memory_tags text[] default '{}',
  memory_importance real default 1
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_id uuid;
  storage_limit_bytes bigint;
  used_storage_bytes bigint;
begin
  if not app.has_organization_role(target_organization_id, array['owner','admin','member'])
     or not app.organization_accepts_writes(target_organization_id) then
    raise exception 'insufficient organization role' using errcode = '42501';
  end if;
  if memory_type not in ('fact','preference','decision','howto','context') then
    raise exception 'invalid memory type' using errcode = '22023';
  end if;
  perform 1 from public.organizations where id = target_organization_id for update;
  storage_limit_bytes := case app.active_plan(target_organization_id)
    when 'starter' then 1024::bigint * 1024 * 1024
    when 'pro' then 5120::bigint * 1024 * 1024
    when 'team' then 20480::bigint * 1024 * 1024
    else 100::bigint * 1024 * 1024
  end;
  select
    coalesce((select sum(octet_length(title) + octet_length(body)) from public.memories where organization_id = target_organization_id), 0)
    + coalesce((select sum(octet_length(content)) from public.document_chunks where organization_id = target_organization_id), 0)
    into used_storage_bytes;
  if used_storage_bytes + octet_length(memory_title) + octet_length(memory_body) > storage_limit_bytes then
    raise exception 'storage quota exceeded' using errcode = 'P0001', detail = 'storage_quota_exceeded';
  end if;
  insert into public.memories(organization_id, project_id, type, title, body, tags, importance)
    values (target_organization_id, target_project_id, memory_type, memory_title, memory_body,
            coalesce(memory_tags, '{}'), memory_importance)
    returning id into new_id;
  return new_id;
end
$$;

create or replace function app.add_document(
  target_organization_id uuid,
  target_project_id uuid,
  document_uri text,
  document_title text,
  document_source text,
  document_kind text,
  document_content text
)
returns table(document_id uuid, chunk_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  storage_limit_bytes bigint;
  used_storage_bytes bigint;
begin
  if not app.has_organization_role(target_organization_id, array['owner','admin','member'])
     or not app.organization_accepts_writes(target_organization_id) then
    raise exception 'insufficient organization role' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = target_organization_id for update;
  storage_limit_bytes := case app.active_plan(target_organization_id)
    when 'starter' then 1024::bigint * 1024 * 1024
    when 'pro' then 5120::bigint * 1024 * 1024
    when 'team' then 20480::bigint * 1024 * 1024
    else 100::bigint * 1024 * 1024
  end;
  select
    coalesce((select sum(octet_length(title) + octet_length(body)) from public.memories where organization_id = target_organization_id), 0)
    + coalesce((select sum(octet_length(content)) from public.document_chunks where organization_id = target_organization_id), 0)
    into used_storage_bytes;
  if used_storage_bytes + octet_length(document_content) > storage_limit_bytes then
    raise exception 'storage quota exceeded' using errcode = 'P0001', detail = 'storage_quota_exceeded';
  end if;
  insert into public.documents(organization_id, project_id, uri, title, source, kind)
    values (target_organization_id, target_project_id, document_uri, document_title, document_source,
            coalesce(document_kind, 'reference'))
    returning id into document_id;
  insert into public.document_chunks(organization_id, document_id, sequence, content)
    values (target_organization_id, document_id, 0, document_content)
    returning id into chunk_id;
  return next;
end
$$;

create or replace function app.search_knowledge(
  target_organization_id uuid,
  search_query text,
  result_limit integer default 20
)
returns table(
  resource_type text,
  resource_id uuid,
  project_id uuid,
  title text,
  snippet text,
  rank real
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with query as (select websearch_to_tsquery('simple', search_query) value),
  candidates as (
    select 'memory'::text resource_type, memory.id resource_id, memory.project_id,
           memory.title, left(memory.body, 320) snippet,
           ts_rank(to_tsvector('simple', memory.title || ' ' || memory.body), query.value) rank
    from public.memories memory, query
    where memory.organization_id = target_organization_id
      and to_tsvector('simple', memory.title || ' ' || memory.body) @@ query.value
    union all
    select 'document'::text, document.id, document.project_id, document.title,
           left(chunk.content, 320),
           ts_rank(to_tsvector('simple', coalesce(chunk.heading, '') || ' ' || chunk.content), query.value)
    from public.documents document
    join public.document_chunks chunk
      on chunk.organization_id = document.organization_id and chunk.document_id = document.id,
      query
    where document.organization_id = target_organization_id
      and to_tsvector('simple', coalesce(chunk.heading, '') || ' ' || chunk.content) @@ query.value
  )
  select * from candidates order by rank desc limit least(greatest(result_limit, 1), 50)
$$;

revoke all on function app.active_plan(uuid) from public;
revoke all on function app.create_project(uuid, text, jsonb) from public;
revoke all on function app.add_memory(uuid, uuid, text, text, text, text[], real) from public;
revoke all on function app.add_document(uuid, uuid, text, text, text, text, text) from public;
revoke all on function app.search_knowledge(uuid, text, integer) from public;
grant execute on function app.create_project(uuid, text, jsonb) to authenticated;
grant execute on function app.add_memory(uuid, uuid, text, text, text, text[], real) to authenticated;
grant execute on function app.add_document(uuid, uuid, text, text, text, text, text) to authenticated;
grant execute on function app.search_knowledge(uuid, text, integer) to authenticated;

create or replace function app.protect_membership_identity()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id <> old.organization_id or new.user_id <> old.user_id then
    raise exception 'membership identity is immutable' using errcode = '42501';
  end if;
  return new;
end
$$;

create or replace function app.prevent_ownerless_organization()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.organizations organization where organization.id = old.organization_id
  ) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if not exists (
    select 1 from public.organization_members member
    where member.organization_id = old.organization_id and member.role = 'owner'
  ) then
    raise exception 'organization must retain an owner' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

drop trigger if exists protect_membership_identity on public.organization_members;
create trigger protect_membership_identity
before update on public.organization_members
for each row execute function app.protect_membership_identity();

drop trigger if exists prevent_ownerless_organization on public.organization_members;
create constraint trigger prevent_ownerless_organization
after update or delete on public.organization_members
deferrable initially immediate
for each row execute function app.prevent_ownerless_organization();

-- Every tenant-owned table is both RLS-enabled and forced. FORCE protects
-- against accidental access through table-owner application connections.
alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.organizations enable row level security;
alter table public.organizations force row level security;
alter table public.organization_members enable row level security;
alter table public.organization_members force row level security;
alter table public.organization_invitations enable row level security;
alter table public.organization_invitations force row level security;
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
  with check (
    app.has_organization_role(organization_id, array['owner'])
    or (app.has_organization_role(organization_id, array['admin']) and role <> 'owner')
  );
create policy organization_members_admin_update on public.organization_members
  for update to authenticated
  using (
    app.has_organization_role(organization_id, array['owner'])
    or (app.has_organization_role(organization_id, array['admin']) and role <> 'owner')
  )
  with check (
    app.has_organization_role(organization_id, array['owner'])
    or (app.has_organization_role(organization_id, array['admin']) and role <> 'owner')
  );
create policy organization_members_admin_delete on public.organization_members
  for delete to authenticated
  using (
    app.has_organization_role(organization_id, array['owner'])
    or (app.has_organization_role(organization_id, array['admin']) and role <> 'owner')
  );

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
grant select on public.organizations to authenticated;
grant select on public.organization_members to authenticated;
grant select, update, delete on public.projects to authenticated;
grant select, update, delete on public.memories to authenticated;
grant select, update, delete on public.documents to authenticated;
grant select on public.document_chunks to authenticated;
grant select, insert, update, delete on public.session_logs to authenticated;
grant select, insert, update, delete on public.memory_relations to authenticated;
grant select on public.audit_events to authenticated;

-- Intentionally no authenticated grants for billing_customers, subscriptions,
-- or billing_webhook_events. Those tables are service-role only.
