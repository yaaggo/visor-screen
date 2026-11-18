-- Visor: perfis por usuario (auth anonima), servidores publicos, canais (texto | tela), mensagens.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  created_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[a-zA-Z0-9_.-]{2,20}$')
);
create unique index profiles_username_lower on public.profiles (lower(username));

create table public.servers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 32),
  owner_id uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index servers_owner_idx on public.servers (owner_id);

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 24),
  kind text not null check (kind in ('text', 'screen')),
  created_at timestamptz not null default now()
);
create index channels_server_idx on public.channels (server_id, created_at);

create table public.messages (
  id bigint generated always as identity primary key,
  channel_id uuid not null references public.channels (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null default auth.uid(),
  author_name text not null,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index messages_channel_idx on public.messages (channel_id, created_at desc);
create index messages_author_idx on public.messages (author_id);

alter table public.profiles enable row level security;
alter table public.servers enable row level security;
alter table public.channels enable row level security;
alter table public.messages enable row level security;

-- Perfis
create policy "profiles read" on public.profiles for select to authenticated using (true);
create policy "profiles insert own" on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);
create policy "profiles delete own" on public.profiles for delete to authenticated
  using ((select auth.uid()) = id);

-- Servidores: publicos para leitura, dono cria/edita/apaga
create policy "servers read" on public.servers for select to authenticated using (true);
create policy "servers insert" on public.servers for insert to authenticated
  with check ((select auth.uid()) = owner_id);
create policy "servers update owner" on public.servers for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "servers delete owner" on public.servers for delete to authenticated
  using ((select auth.uid()) = owner_id);

-- Canais: leitura publica, dono do servidor gerencia
create policy "channels read" on public.channels for select to authenticated using (true);
create policy "channels insert owner" on public.channels for insert to authenticated
  with check (exists (select 1 from public.servers s where s.id = server_id and s.owner_id = (select auth.uid())));
create policy "channels delete owner" on public.channels for delete to authenticated
  using (exists (select 1 from public.servers s where s.id = server_id and s.owner_id = (select auth.uid())));

-- Mensagens: so em canais de texto, como si mesmo, com o proprio username
create policy "messages read" on public.messages for select to authenticated using (true);
create policy "messages insert" on public.messages for insert to authenticated
  with check (
    (select auth.uid()) = author_id
    and exists (select 1 from public.channels c where c.id = channel_id and c.kind = 'text')
    and exists (select 1 from public.profiles p where p.id = author_id and p.username = author_name)
  );
create policy "messages delete own" on public.messages for delete to authenticated
  using ((select auth.uid()) = author_id);

-- Cria servidor + canais padrao de forma atomica (RLS continua valendo: security invoker)
create or replace function public.create_server(server_name text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_id uuid;
begin
  insert into public.servers (name, owner_id) values (btrim(server_name), auth.uid()) returning id into new_id;
  insert into public.channels (server_id, name, kind) values
    (new_id, 'geral', 'text'),
    (new_id, 'tela', 'screen');
  return new_id;
end;
$$;
revoke execute on function public.create_server(text) from public, anon;
grant execute on function public.create_server(text) to authenticated;

-- Realtime para listas e chat
alter publication supabase_realtime add table public.servers, public.channels, public.messages;
