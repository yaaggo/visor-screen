import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Hash, LogOut, Monitor, Plus, Trash2, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { go, inviteUrl, useRoute } from '../lib/route.js'
import { Avatar, CopyButton, HoldButton, IconButton, Segmented, usePopover } from './ui.jsx'
import TextChannel from './TextChannel.jsx'
import ProfilePhoto from './ProfilePhoto.jsx'
import ScreenChannel from './ScreenChannel.jsx'

// Lista viva de uma tabela (select inicial + realtime)
function useLive(table, filter, order, deps) {
  const [rows, setRows] = useState(null)
  useEffect(() => {
    if (filter === false) return setRows(null)
    let alive = true
    let q = supabase.from(table).select('*').order(order, { ascending: true })
    if (filter) q = q.eq(filter[0], filter[1])
    q.then(({ data }) => alive && setRows(data ?? []))
    const ch = supabase
      .channel(`live:${table}:${filter?.[1] ?? 'all'}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, ...(filter ? { filter: `${filter[0]}=eq.${filter[1]}` } : {}) }, (p) => {
        setRows((prev) => {
          if (!prev) return prev
          if (p.eventType === 'INSERT') return prev.some((r) => r.id === p.new.id) ? prev : [...prev, p.new]
          if (p.eventType === 'UPDATE') return prev.map((r) => (r.id === p.new.id ? p.new : r))
          if (p.eventType === 'DELETE') return prev.filter((r) => r.id !== p.old.id)
          return prev
        })
      })
      .subscribe()
    // DELETE nao respeita filtro: escuta sem filtro tambem
    const del = filter
      ? supabase
          .channel(`live-del:${table}:${filter[1]}:${Math.random().toString(36).slice(2)}`)
          .on('postgres_changes', { event: 'DELETE', schema: 'public', table }, (p) =>
            setRows((prev) => prev && prev.filter((r) => r.id !== p.old.id)),
          )
          .subscribe()
      : null
    return () => {
      alive = false
      supabase.removeChannel(ch)
      if (del) supabase.removeChannel(del)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return [rows, setRows]
}

export default function Shell({ profile }) {
  const { serverId, channelId } = useRoute()
  const [servers, setServers] = useLive('servers', null, 'created_at', [])
  const [channels, setChannels] = useLive('channels', serverId ? ['server_id', serverId] : false, 'created_at', [serverId])
  const [collapsed, setCollapsed] = useState(false)

  const [editing, setEditing] = useState(false)
  const [photo, setPhoto] = useState(0)
  const [roster, setRoster] = useState(null)

  const directory = useRef(null)
  const member = useRef(null)
  const [visitors, setVisitors] = useState([])
  const reportMember = useCallback(value => {
    member.current = value
    // Effects can replace a status during the same React commit.
    queueMicrotask(() => {
      if (member.current !== value || !directory.current) return
      if (value) directory.current.track(value)
      else directory.current.untrack()
    })
  }, [])
  useEffect(() => {
    setVisitors([])
    if (!serverId) return
    let alive = true
    const dir = supabase.channel('calls:' + serverId, { config: { presence: { key: profile.id } } })
    dir.on('presence', { event: 'sync' }, () => {
      if (alive) setVisitors(Object.entries(dir.presenceState()).flatMap(([id, entries]) => entries.map(meta => ({ ...meta, id }))))
    }).subscribe(status => {
      if (alive && status === 'SUBSCRIBED') {
        directory.current = dir
        if (member.current) dir.track(member.current)
      }
    })
    return () => { alive = false; directory.current = null; supabase.removeChannel(dir) }
  }, [serverId, profile.id])

  const server = servers?.find((s) => s.id === serverId) ?? null
  const channel = channels?.find((c) => c.id === channelId) ?? null
  const isOwner = server?.owner_id === profile.id

  // Rota padrao: primeiro servidor / primeiro canal
  useEffect(() => {
    if (!servers) return
    if (serverId && !server) return go(servers[0]?.id ?? null)
    if (!serverId && servers.length) return go(servers[0].id)
  }, [servers, serverId, server])
  useEffect(() => {
    if (!channels || !serverId) return
    if (!channel && channels.length) go(serverId, channels[0].id)
  }, [channels, channel, serverId])

  const createServer = async (name) => {
    const { data, error } = await supabase.rpc('create_server', { server_name: name })
    if (error) return false
    const { data: row } = await supabase.from('servers').select('*').eq('id', data).single()
    if (row) setServers((prev) => (prev?.some((s) => s.id === row.id) ? prev : [...(prev ?? []), row]))
    go(data)
    return true
  }

  const createChannel = async (name, kind) => {
    const { data, error } = await supabase.from('channels').insert({ server_id: serverId, name, kind }).select().single()
    if (error) return false
    setChannels((prev) => (prev?.some((c) => c.id === data.id) ? prev : [...(prev ?? []), data]))
    go(serverId, data.id)
    return true
  }

  const deleteServer = async () => {
    await supabase.from('servers').delete().eq('id', serverId)
    setServers((prev) => prev.filter((s) => s.id !== serverId))
    go(null)
  }

  const deleteChannel = async (id) => {
    await supabase.from('channels').delete().eq('id', id)
    setChannels((prev) => prev.filter((c) => c.id !== id))
    if (id === channelId) go(serverId)
  }

  const logout = async () => {
    await supabase.auth.signOut()
  }

  const firstText = channels?.find((c) => c.kind === 'text') ?? null

  return (
    <div className={`shell ${collapsed ? 'is-collapsed' : ''}`}>
      <nav className="rail" aria-label="Servidores">
        <PillList
          items={servers ?? []}
          activeId={serverId}
          render={(s) => (
            <button key={s.id} type="button" data-id={s.id} className={`rail-item ${s.id === serverId ? 'is-active' : ''}`} data-tip={s.name} aria-label={s.name} onClick={() => go(s.id)}>
              {s.name.slice(0, 2)}
            </button>
          )}
        />
        <CreateServer onCreate={createServer} />
        <div className="rail-foot">
          <button className="me" aria-label="Editar foto de perfil" data-tip={profile.username} onClick={() => setEditing(true)}>
            <Avatar id={profile.id} revision={photo} name={profile.username} size={32} />
          </button>
          <IconButton label="Sair" onClick={logout}>
            <LogOut size={16} strokeWidth={1.75} />
          </IconButton>
        </div>
      </nav>

      {editing && <ProfilePhoto profile={profile} saved={setPhoto} close={() => setEditing(false)} />}
      <aside className="sidebar" aria-label="Canais">
        {server ? (
          <>
            <header className="side-head">
              <h1 title={server.name}>{server.name}</h1>
              <CopyButton text={inviteUrl(serverId, channelId)} />
            </header>
            <PillList
              className="channel-list"
              items={channels ?? []}
              activeId={channelId}
              render={(c) => (
                <div key={c.id}><div data-id={c.id} className="channel-row">
                  <button type="button" className={`channel ${c.id === channelId ? 'is-active' : ''}`} onClick={() => go(serverId, c.id)}>
                    {c.kind === 'text' ? <Hash size={15} strokeWidth={1.75} /> : <Monitor size={15} strokeWidth={1.75} />}
                    <span>{c.name}</span>
                  </button>
                  {isOwner && (
                    <button type="button" className="channel-del" aria-label="Remover" onClick={() => deleteChannel(c.id)}>
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  )}
                </div>
                  {c.id !== channelId && c.kind === 'screen' && <div className="channel-people">{visitors.filter(v => v.channel === c.id).map(v =>
                    <button key={v.presence_ref} className="participant" onClick={() => go(serverId,c.id)}>
                      <span className="participant-face"><Avatar id={v.id} revision={v.photo} name={v.name} size={24}/>{v.sharing && <i className="live-dot"/>}</span>{v.name}
                    </button>)}</div>}
                  {c.id === channelId && c.kind === 'screen' && <div ref={setRoster} />}
                </div>
              )}
            />
            {isOwner && (
              <div className="side-foot">
                <CreateChannel onCreate={createChannel} />
                <HoldButton label="Segure para apagar" onConfirm={deleteServer}>
                  <Trash2 size={15} strokeWidth={1.75} />
                </HoldButton>
              </div>
            )}
          </>
        ) : (
          <div className="side-empty" />
        )}
      </aside>

      <main className="main">
        <header className="main-head">
          <IconButton label={collapsed ? 'Expandir' : 'Recolher'} onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.75} /> : <PanelLeftClose size={16} strokeWidth={1.75} />}
          </IconButton>
          {channel && (
            <div className="main-title" key={channel.id}>
              {channel.kind === 'text' ? <Hash size={15} strokeWidth={1.75} /> : <Monitor size={15} strokeWidth={1.75} />}
              <span>{channel.name}</span>
            </div>
          )}
        </header>
        <div className="main-body">
          {!servers ? null : !servers.length ? (
            <EmptyState onCreate={createServer} />
          ) : channel?.kind === 'text' ? (
            <TextChannel key={channel.id} channel={channel} profile={profile} />
          ) : channel?.kind === 'screen' ? (
            <ScreenChannel reportMember={reportMember} roster={roster} photo={photo} key={channel.id} channel={channel} profile={profile} chatChannel={firstText} />
          ) : null}
        </div>
      </main>
    </div>
  )
}

// Lista com indicador deslizante atras do item ativo
function PillList({ items, activeId, render, className = 'rail-list' }) {
  const ref = useRef(null)
  const [pill, setPill] = useState(null)
  useLayoutEffect(() => {
    const el = activeId && ref.current?.querySelector(`[data-id="${activeId}"]`)
    setPill(el ? { top: el.offsetTop, height: el.offsetHeight } : null)
  }, [activeId, items])
  return (
    <div ref={ref} className={`pill-list ${className}`}>
      <span className={`list-pill ${pill ? 'is-on' : ''}`} style={pill ? { translate: `0 ${pill.top}px`, height: pill.height } : undefined} />
      {items.map(render)}
    </div>
  )
}

function NameForm({ placeholder, onSubmit, max, children, extra }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    const v = name.trim()
    if (!v || busy) return
    setBusy(true)
    const ok = await onSubmit(v)
    setBusy(false)
    if (!ok) {
      setShake(true)
      setTimeout(() => setShake(false), 400)
    }
  }
  return (
    <form className={`name-form ${shake ? 'shake' : ''}`} onSubmit={submit}>
      {extra}
      <div className="name-row">
        <input autoFocus value={name} maxLength={max} placeholder={placeholder} onChange={(e) => setName(e.target.value)} />
        <button className="mini-go" disabled={!name.trim() || busy} aria-label="Criar">
          {children}
        </button>
      </div>
    </form>
  )
}

function CreateServer({ onCreate }) {
  const pop = usePopover()
  return (
    <div className="pop-anchor" ref={pop.ref}>
      <IconButton label="Novo servidor" active={pop.open} className="rail-add" onClick={() => pop.setOpen((v) => !v)}>
        <Plus size={18} strokeWidth={1.75} className="plus" />
      </IconButton>
      <div className={`popover pop-right ${pop.open ? 'is-open' : ''}`}>
        {pop.open && (
          <NameForm placeholder="servidor" max={32} onSubmit={async (v) => (await onCreate(v)) && (pop.setOpen(false), true)}>
            <Plus size={15} />
          </NameForm>
        )}
      </div>
    </div>
  )
}

function CreateChannel({ onCreate }) {
  const pop = usePopover()
  const [kind, setKind] = useState('text')
  return (
    <div className="pop-anchor" ref={pop.ref}>
      <IconButton label="Novo canal" active={pop.open} onClick={() => pop.setOpen((v) => !v)}>
        <Plus size={16} strokeWidth={1.75} className="plus" />
      </IconButton>
      <div className={`popover pop-up ${pop.open ? 'is-open' : ''}`}>
        {pop.open && (
          <NameForm
            placeholder="canal"
            max={24}
            onSubmit={async (v) => (await onCreate(v, kind)) && (pop.setOpen(false), true)}
            extra={
              <Segmented
                label="Tipo"
                size="sm"
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'text', label: 'Texto', icon: <Hash size={14} /> },
                  { value: 'screen', label: 'Tela', icon: <Monitor size={14} /> },
                ]}
              />
            }
          >
            <Plus size={15} />
          </NameForm>
        )}
      </div>
    </div>
  )
}

function EmptyState({ onCreate }) {
  return (
    <div className="empty">
      <div className="empty-mark" aria-hidden>
        <Monitor size={28} strokeWidth={1.25} />
      </div>
      <NameForm placeholder="nome do servidor" max={32} onSubmit={onCreate}>
        <Plus size={15} />
      </NameForm>
    </div>
  )
}
