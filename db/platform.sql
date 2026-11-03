-- ============================================================================
-- What a Supabase project provides, recreated on a plain Postgres (Neon).
--
-- Applied by `npm run db:migrate` before supabase/migrations/*.sql, and safe to
-- re-run: every statement is idempotent. The migrations and their row level
-- security policies then run unchanged, because the pieces they rely on exist
-- under the same names:
--
--   roles     anon, authenticated, service_role
--   auth      users, auth.uid(), auth.role(), auth.jwt()
--   storage   buckets, objects (file bytes live in objects.data)
--
-- The application (app/lib/neon/) plays the part of Supabase's servers: it
-- runs each signed-in request as `authenticated` with the user's claims set,
-- exactly as PostgREST does, so every policy is enforced by the database.
-- ============================================================================

create extension if not exists pgcrypto;

-- ── Roles ───────────────────────────────────────────────────────────────────
-- NOLOGIN: nobody connects as these; the app switches to them with SET ROLE
-- inside each transaction. The connecting role (Neon's database owner) must be
-- a member to do that.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- BYPASSRLS needs a superuser on some hosts. The app never SETs this
    -- role — trusted work runs as the table owner, which RLS already
    -- exempts — so it only has to exist for the migrations' grants.
    begin
      create role service_role nologin bypassrls;
    exception when insufficient_privilege then
      create role service_role nologin;
    end;
  end if;
end $$;

do $$
begin
  execute format('grant anon, authenticated, service_role to %I', current_user);
exception when others then
  raise notice 'Could not grant the API roles to %: %', current_user, sqlerrm;
end $$;

-- ── auth ────────────────────────────────────────────────────────────────────
create schema if not exists auth;

create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text,
  encrypted_password  text,
  raw_user_meta_data  jsonb not null default '{}',
  raw_app_meta_data   jsonb not null default '{}',
  email_confirmed_at  timestamptz,
  last_sign_in_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists users_email_key on auth.users (lower(email));

-- One row per signed-in browser. Deleting it signs that browser out.
create table if not exists auth.sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  aal           text not null default 'aal1',
  amr           jsonb not null default '[]',
  created_at    timestamptz not null default now(),
  refreshed_at  timestamptz not null default now(),
  user_agent    text,
  ip            text
);
create index if not exists sessions_user_idx on auth.sessions (user_id);

-- Authenticator apps (TOTP).
create table if not exists auth.mfa_factors (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  friendly_name   text,
  factor_type     text not null default 'totp',
  status          text not null default 'unverified',
  secret          text not null,
  last_used_step  bigint,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists mfa_factors_user_idx on auth.mfa_factors (user_id);

-- Nothing in auth is reachable by the API roles directly; the policies and
-- functions that need it are SECURITY DEFINER, as on Supabase.
revoke all on all tables in schema auth from anon, authenticated;

-- The same claim lookups Supabase defines. Both the per-claim settings and
-- the whole-JWT setting are read, as Supabase's versions do.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function auth.email() returns text language sql stable as $$
  select auth.jwt() ->> 'email'
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role(), auth.jwt(), auth.email()
  to anon, authenticated, service_role;

-- ── storage ─────────────────────────────────────────────────────────────────
create schema if not exists storage;

create table if not exists storage.buckets (
  id                  text primary key,
  name                text not null,
  public              boolean not null default false,
  file_size_limit     bigint,
  allowed_mime_types  text[],
  created_at          timestamptz not null default now()
);

create table if not exists storage.objects (
  id            uuid primary key default gen_random_uuid(),
  bucket_id     text not null references storage.buckets,
  name          text not null,
  owner         uuid,
  content_type  text,
  size          bigint,
  data          bytea,
  metadata      jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;

grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;

-- ── public ──────────────────────────────────────────────────────────────────
-- Supabase grants the API roles everything in public and leaves the real
-- decision to row level security. The migrations are written for that.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;

-- Which migrations have been applied (see scripts/db-migrate.mjs).
create schema if not exists bluinn_meta;
create table if not exists bluinn_meta.migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
);
revoke all on schema bluinn_meta from public;
