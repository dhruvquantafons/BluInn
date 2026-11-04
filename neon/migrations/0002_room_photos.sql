-- ============================================================================
-- Room photography storage
-- Run after 0001_init.sql, in the Supabase SQL editor.
-- ============================================================================

-- Public bucket: the marketing site must be able to load these without a key.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'room-photos',
  'room-photos',
  true,
  5242880,  -- 5 MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Anyone may read a room photo; only administrators may add or remove one.
drop policy if exists "room photos are publicly readable" on storage.objects;
create policy "room photos are publicly readable"
  on storage.objects for select
  using (bucket_id = 'room-photos');

drop policy if exists "admins upload room photos" on storage.objects;
create policy "admins upload room photos"
  on storage.objects for insert
  with check (bucket_id = 'room-photos' and public.is_admin());

drop policy if exists "admins update room photos" on storage.objects;
create policy "admins update room photos"
  on storage.objects for update
  using (bucket_id = 'room-photos' and public.is_admin());

drop policy if exists "admins delete room photos" on storage.objects;
create policy "admins delete room photos"
  on storage.objects for delete
  using (bucket_id = 'room-photos' and public.is_admin());
