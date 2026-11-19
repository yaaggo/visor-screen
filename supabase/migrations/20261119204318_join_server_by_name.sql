-- The existing authenticated join RPC now accepts an exact name as well as an invite.
create or replace function private.join_server(code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  if auth.uid() is null then raise exception 'Sessão necessária'; end if;
  select id into target from public.servers where invite_code = upper(btrim(code));
  if target is null then
    begin
      select id into strict target from public.servers where lower(name) = lower(btrim(code));
    exception
      when too_many_rows then raise exception 'Nome repetido. Use o código de convite.' using errcode='P0003';
      when no_data_found then raise exception 'Servidor não encontrado.' using errcode='P0002';
    end;
  end if;
  insert into public.server_members(profile_id, server_id) values (auth.uid(), target)
    on conflict do nothing;
  return target;
end;
$$;
