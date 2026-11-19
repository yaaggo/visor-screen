insert into storage.buckets (id, name, public, file_size_limit)
values ('desktop-updates','desktop-updates',false,33554432);
create policy desktop_updates_read on storage.objects for select to authenticated
using (bucket_id = 'desktop-updates');
