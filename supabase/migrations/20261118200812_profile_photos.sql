insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 65536, array['image/webp']);

create policy avatar_insert on storage.objects for insert to authenticated
with check (bucket_id = 'avatars' and name = (select auth.uid())::text || '.webp');
create policy avatar_read_own on storage.objects for select to authenticated
using (bucket_id = 'avatars' and name = (select auth.uid())::text || '.webp');
create policy avatar_replace on storage.objects for update to authenticated
using (bucket_id = 'avatars' and name = (select auth.uid())::text || '.webp')
with check (bucket_id = 'avatars' and name = (select auth.uid())::text || '.webp');
