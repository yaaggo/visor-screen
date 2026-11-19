alter table public.servers add column photo_revision bigint not null default 0;

create or replace function public.create_server(server_name text) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare new_id uuid;
begin
  insert into public.servers(name, owner_id) values (trim(server_name), auth.uid()) returning id into new_id;
  insert into public.channels(server_id, name, kind) values (new_id, 'tela', 'screen');
  return new_id;
end;
$$;

insert into public.channels(server_id, name, kind)
select s.id, 'tela', 'screen' from public.servers s
where not exists (select 1 from public.channels c where c.server_id = s.id and c.kind = 'screen');

-- Preserva o historico anterior e restringe novas gravacoes.
alter table public.channels add constraint new_channels_screen check (kind = 'screen') not valid;
create policy "only call chat" on public.messages as restrictive for insert to authenticated
with check (channel_id in (select id from public.channels where kind = 'screen'));

create policy server_photo_insert on storage.objects for insert to authenticated
with check (bucket_id = 'avatars' and name in (select 'servers/' || s.id || '.webp' from public.servers s where s.owner_id = (select auth.uid())));
create policy server_photo_select on storage.objects for select to authenticated
using (bucket_id = 'avatars' and name in (select 'servers/' || s.id || '.webp' from public.servers s where s.owner_id = (select auth.uid())));
create policy server_photo_update on storage.objects for update to authenticated
using (bucket_id = 'avatars' and name in (select 'servers/' || s.id || '.webp' from public.servers s where s.owner_id = (select auth.uid())))
with check (bucket_id = 'avatars' and name in (select 'servers/' || s.id || '.webp' from public.servers s where s.owner_id = (select auth.uid())));
