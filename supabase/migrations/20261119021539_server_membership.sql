alter table public.servers add column invite_code text not null unique
  default upper(left(replace(gen_random_uuid()::text, '-', ''), 10));

create table public.server_members (
  profile_id uuid not null references public.profiles on delete cascade,
  server_id uuid not null references public.servers on delete cascade,
  primary key (profile_id, server_id)
);
create index server_members_server_idx on public.server_members(server_id);
alter table public.server_members enable row level security;
revoke all on public.server_members from anon, authenticated;
grant select on public.server_members to authenticated;
create policy "own memberships" on public.server_members for select to authenticated
  using (profile_id = (select auth.uid()));

alter policy "servers read" on public.servers using (
  owner_id = (select auth.uid()) or id in (select server_id from public.server_members)
);
alter policy "channels read" on public.channels using (server_id in (select id from public.servers));
alter policy "messages read" on public.messages using (channel_id in (select id from public.channels));
alter policy "messages insert" on public.messages with check (
  author_id = (select auth.uid()) and channel_id in (select id from public.channels)
  and exists (select 1 from public.profiles p where p.id = author_id and p.username = author_name)
);

create schema if not exists private;
grant usage on schema private to authenticated;
create function private.join_server(code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  if auth.uid() is null then raise exception 'Sessão necessária'; end if;
  select id into strict target from public.servers where invite_code = upper(trim(code));
  insert into public.server_members(profile_id, server_id) values (auth.uid(), target)
    on conflict do nothing;
  return target;
end;
$$;
create function public.join_server(code text) returns uuid language sql security invoker
set search_path = '' as $$ select private.join_server(code) $$;
revoke all on function private.join_server(text), public.join_server(text) from public, anon;
grant execute on function private.join_server(text), public.join_server(text) to authenticated;

create function private.call_topic_allowed() returns boolean language sql stable security invoker
set search_path = '' as $$
  select exists (select 1 from public.servers where 'calls:' || id::text = realtime.topic())
    or exists (select 1 from public.channels where kind = 'screen' and 'screen:' || id::text = realtime.topic())
$$;
revoke all on function private.call_topic_allowed() from public, anon;
grant execute on function private.call_topic_allowed() to authenticated;
create policy "members receive call events" on realtime.messages for select to authenticated
  using (extension in ('broadcast','presence') and (select private.call_topic_allowed()));
create policy "members send call events" on realtime.messages for insert to authenticated
  with check (extension in ('broadcast','presence') and (select private.call_topic_allowed()));
