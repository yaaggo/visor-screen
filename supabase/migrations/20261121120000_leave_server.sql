-- Sair de um servidor: cada usuario apaga apenas a propria participacao.
grant delete on public.server_members to authenticated;
create policy "leave own memberships" on public.server_members for delete to authenticated
  using (profile_id = (select auth.uid()));
