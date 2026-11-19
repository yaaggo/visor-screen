import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Cast, ImagePlus, LogOut, Monitor, Plus, PhoneOff, Radio, Smartphone, Trash2, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { deviceKind, endpointId, presencePublisher } from '../lib/presence.js'
import { go, useRoute } from '../lib/route.js'
import { Avatar, CopyButton, HoldButton, IconButton, ServerFace, usePopover } from './ui.jsx'
import ServerHub from './ServerHub.jsx'
import Tooltips from './Tooltips.jsx'
import ProfilePhoto from './ProfilePhoto.jsx'
import ScreenChannel from './ScreenChannel.jsx'

// Lista viva de uma tabela (select inicial + realtime)
function useLive(table, filter, order, deps) {
  const [rows, setRows] = useState(null)
  useEffect(() => {
    setRows(null)
    if (filter === false) return
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
  const [serverPhoto, setServerPhoto] = useState(null)
  const [photo, setPhoto] = useState(0)

  const [call, setCall] = useState(null)
  const [connected, setConnected] = useState(false)
  const origin = useRef(null)
  const directoryServer = call?.server_id ?? serverId
  const directory = useRef(null)
  const member = useRef(null)
  const [visitors, setVisitors] = useState([])
  const reportMember = useCallback(value => {
    member.current = value
    // Effects can replace a status during the same React commit.
    queueMicrotask(() => {
      if (member.current !== value || !directory.current) return
      directory.current.refresh()
    })
  }, [])
  useEffect(() => {
    setVisitors([])
    if (!directoryServer) return
    let alive = true
    const dir = supabase.channel('calls:' + directoryServer, { config: { private: true, presence: { key: endpointId } } })
    let tracked = false
    const publisher = presencePublisher(() => {
      if (dir.state !== 'joined') return
      if (member.current) {
        tracked = true
        return dir.track({ ...member.current, endpointId, profileId: profile.id, device: member.current.device ?? deviceKind })
      }
      if (tracked) return dir.untrack().then(status => {
        if (status === 'ok' && !member.current) tracked = false
        return status
      })
    })
    dir.on('presence', { event: 'sync' }, () => {
      if (alive) setVisitors(Object.entries(dir.presenceState()).flatMap(([id, entries]) => entries.map(meta => ({ ...meta, id }))))
    }).subscribe(status => {
      if (alive && status === 'SUBSCRIBED') {
        directory.current = publisher
        publisher.refresh()
      }
    })
    return () => { alive = false; publisher.close(); directory.current = null; supabase.removeChannel(dir) }
  }, [directoryServer, profile.id])

  const [browsingVisitors, setBrowsingVisitors] = useState([])
  useEffect(() => {
    setBrowsingVisitors([])
    if (!serverId || serverId === directoryServer) return
    const dir = supabase.channel('calls:' + serverId, {config:{private:true,presence:{key:endpointId}}})
    dir.on('presence',{event:'sync'},() => {
      setBrowsingVisitors(Object.entries(dir.presenceState()).flatMap(([id, entries]) =>
        entries.map(meta => ({...meta,id}))))
    }).subscribe()
    return () => { supabase.removeChannel(dir) }
  }, [serverId, directoryServer])
  const listedVisitors = directoryServer === serverId ? visitors : browsingVisitors

  const server = servers?.find((s) => s.id === serverId) ?? null
  const channel = channels?.find((c) => c.kind === 'screen' && c.server_id === serverId && c.id === channelId) ?? null
  const isOwner = server?.owner_id === profile.id

  useEffect(() => {
    if (serverId && servers && !server) go(null)
  }, [servers, serverId, server])
  useEffect(() => {
    if (channelId && channels?.some(c => c.server_id === serverId) && !channel) go(serverId)
  }, [channels, channel, channelId, serverId])
  useEffect(() => {
    if (channel?.kind === 'screen') setCall(channel)
  }, [channel])
  useEffect(() => {
    if (call && servers && !servers.some(s => s.id === call.server_id)) setCall(null)
  }, [servers, call])
  useEffect(() => {
    if (!call) return
    const sub = supabase.channel('call-lifecycle:' + call.id)
      .on('postgres_changes', {event:'DELETE', schema:'public', table:'channels'}, p => {
        if (p.old.id === call.id) setCall(null)
      }).subscribe()
    return () => { supabase.removeChannel(sub) }
  }, [call?.id])
  useLayoutEffect(() => {
    const move = origin.current
    if (!move) return
    origin.current = null
    const item = serverId ? document.querySelector('.rail-item.is-active')
      : document.querySelector(`[data-server="${CSS.escape(move.id)}"]`)
    if (!item || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    item.scrollIntoView({ block:'nearest', inline:'nearest' })
    const to = item.getBoundingClientRect()
    const from = move.rect
    const ghost = item.cloneNode(true)
    ghost.className = 'server-flight'
    ghost.removeAttribute('data-tip')
    ghost.inert = true
    Object.assign(ghost.style, { left:to.left+'px', top:to.top+'px', width:to.width+'px', height:to.height+'px',
      borderRadius:getComputedStyle(item).borderRadius, fontSize:getComputedStyle(item).fontSize })
    document.body.append(ghost)
    const dx = from.x + from.width/2 - to.x - to.width/2
    const dy = from.y + from.height/2 - to.y - to.height/2
    item.style.visibility = 'hidden'
    const flight = ghost.animate([{ transform:`translate(${dx}px,${dy}px) scale(${from.width/to.width})` }, { transform:'none' }],
      { duration:580, easing:'cubic-bezier(.23,.78,.2,1)' })
    const restore = () => { ghost.remove(); item.style.visibility = '' }
    flight.onfinish = restore
    return () => { flight.cancel(); restore() }
  }, [serverId])
  function openServer(row, node) {
    const previous = document.querySelector('.rail-item.is-active')
    origin.current = { id:row.id, rect:(previous ?? node).getBoundingClientRect() }
    const next = row.id === serverId ? null : row.id
    go(next, next && call?.server_id === next ? call.id : null)
  }
  async function submitServer(step, value) {
    const {data, error} = step === 'create'
      ? await supabase.rpc('create_server', {server_name:value})
      : await supabase.rpc('join_server', {code:value})
    if (error) throw error
    const {data:row, error:readError} = await supabase.from('servers').select('*').eq('id',data).single()
    if (readError) throw readError
    setServers(prev => prev?.some(s => s.id === row.id) ? prev : [...(prev ?? []), row])
    return row
  }

  const createChannel = async (name) => {
    const { data, error } = await supabase.from('channels').insert({ server_id: serverId, name, kind:'screen' }).select().single()
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

  function disconnect() {
    if (channel) go(serverId)
    setCall(null)
  }
  const callVisible = Boolean(call && call.id === channel?.id)
  const callLabel = call ? (connected ? 'Conectado' : 'Conectando…') : 'Desconectado'

  return (
    <div className={`shell ${!serverId ? 'in-hub' : ''} ${collapsed ? 'is-collapsed' : ''}`}>
      {server && <nav className="rail" aria-label={server.name}>
        <div className="server-stack">{servers.map(row => <button key={row.id} type="button"
          className={'rail-item' + (row.id === serverId ? ' is-active' : '')}
          aria-current={row.id === serverId ? 'page' : undefined} aria-label={row.name}
          data-tip={row.id === serverId ? 'Voltar aos meus servidores' : row.name}
          onClick={e => openServer(row,e.currentTarget)}><ServerFace server={row}/></button>)}</div>
        <div className="rail-foot">
          <div className={'call-status' + (call ? ' active' : '')}>
            <button disabled={!call} title={callLabel + (call ? ' · '+call.name : '')} aria-label={callLabel}
              onClick={() => go(call.server_id, call.id)}><Radio size={17}/><small>{callLabel}</small></button>
            {call && <button title="Desconectar" aria-label="Desconectar" onClick={disconnect}><PhoneOff size={15}/></button>}
          </div>
          <button className="me" aria-label="Editar foto de perfil" data-tip={profile.username} onClick={() => setEditing(true)}>
            <Avatar id={profile.id} revision={photo} name={profile.username} size={32} />
          </button>
          <IconButton label="Sair" onClick={logout}>
            <LogOut size={16} strokeWidth={1.75} />
          </IconButton>
        </div>
      </nav>}

      <Tooltips/>
      {serverPhoto && <ProfilePhoto server={serverPhoto} saved={revision =>
        setServers(rows => rows.map(row => row.id === serverPhoto.id ? {...row,photo_revision:revision} : row))}
        close={() => setServerPhoto(null)}/>}
      {editing && <ProfilePhoto profile={profile} saved={setPhoto} close={() => setEditing(false)} />}
      {server && <aside className="sidebar" aria-label="Canais">

            <header className="side-head">
              <h1 title={server.name}>{server.name}</h1>
              {isOwner && <IconButton label="Foto do servidor" onClick={() => setServerPhoto(server)}><ImagePlus size={16}/></IconButton>}
              <CopyButton text={server.invite_code} label="Copiar código do servidor" />
            </header>
            <PillList
              className="channel-list"
              items={channels?.filter(c => c.server_id === serverId && c.kind === 'screen') ?? []}
              activeId={channelId}
              render={(c) => (
                <div key={c.id}><div data-id={c.id} className="channel-row">
                  <button type="button" className={`channel ${c.id === channelId ? 'is-active' : ''}`} onClick={() => go(serverId, c.id)}>
                    <Cast size={16} strokeWidth={1.75}/>
                    <span>{c.name}</span>{call?.id === c.id && <Radio size={13} aria-label="Sua chamada"/>}
                  </button>
                  {isOwner && (
                    <button type="button" className="channel-del" aria-label="Remover" onClick={() => deleteChannel(c.id)}>
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  )}
                </div>
                  {c.id !== channelId && c.kind === 'screen' && <div className="channel-people">{listedVisitors.filter(v => v.channel === c.id).map(v =>
                    <button key={v.presence_ref} className="participant" onClick={() => go(serverId,c.id)}>
                      <span className="participant-face"><Avatar id={v.profileId ?? v.id} revision={v.photo} name={v.name} size={24}/>{v.sharing && <i className="live-dot"/>}</span><span className="participant-meta"><span>{v.name}</span>{v.device === 'mobile' ? <Smartphone size={11} className="device-icon" aria-label="Celular"/> : <Monitor size={11} className="device-icon" aria-label="Computador"/>}</span>
                    </button>)}</div>}

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
      </aside>}

      <main className="main">
        {server && <header className="main-head">
          <IconButton label={collapsed ? 'Expandir' : 'Recolher'} onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.75} /> : <PanelLeftClose size={16} strokeWidth={1.75} />}
          </IconButton>
          {channel && (
            <div className="main-title" key={channel.id}>
              <Cast size={16} strokeWidth={1.75}/>
              <span>{channel.name}</span>
            </div>
          )}
        </header>}
        <div className="main-body">
          {!serverId && servers && <ServerHub servers={servers} onSubmit={submitServer} onOpen={openServer} editProfile={() => setEditing(true)} logout={logout}/>}
          {server && !channel && <div className="channel-landing">{channels?.filter(c => c.kind === 'screen' && c.server_id === serverId).map(c =>
            <button key={c.id} onClick={() => go(serverId,c.id)}><Cast size={22}/>{c.name}</button>)}</div>}
          {call && <div className="call-session" hidden={!callVisible}>
            <ScreenChannel key={call.id} channel={call} profile={profile} chatChannel={call} visible={callVisible}
              onConnection={setConnected} reportMember={reportMember} visitors={visitors.filter(v => v.channel === call.id)} photo={photo}/>
          </div>}
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

function CreateChannel({ onCreate }) {
  const pop = usePopover()
  return (
    <div className="pop-anchor" ref={pop.ref}>
      <IconButton label="Novo canal de transmissão" active={pop.open} onClick={() => pop.setOpen((v) => !v)}>
        <Plus size={16} strokeWidth={1.75} className="plus" />
      </IconButton>
      <div className={`popover pop-up ${pop.open ? 'is-open' : ''}`}>
        {pop.open && (
          <NameForm
            placeholder="canal"
            max={24}
            onSubmit={async (v) => (await onCreate(v)) && (pop.setOpen(false), true)}
          >
            <Plus size={15} />
          </NameForm>
        )}
      </div>
    </div>
  )
}
