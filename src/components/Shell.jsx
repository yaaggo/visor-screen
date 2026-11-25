import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, MoreHorizontal, Pencil, Cast, ImagePlus, Link2, TriangleAlert, LogOut, MessageSquare, Monitor, Plus, PhoneOff, Radio, Smartphone, Trash2, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import SoundToggle from './SoundToggle.jsx'
import ServerBoard from './ServerBoard.jsx'
import { play } from '../lib/sound.js'
import { supabase } from '../lib/supabase.js'
import { applyRowEvent, createLiveRows } from '../lib/liveRows.js'
import { deviceKind, endpointId, presencePublisher } from '../lib/presence.js'
import { go, replaceRoute, roomLink, useRoute } from '../lib/route.js'
import { useRadar } from '../lib/radar.js'
import { acquireTopic, presenceList } from '../lib/topics.js'
import { Avatar, CopyButton, IconButton, ServerFace, usePopover } from './ui.jsx'
import ServerHub from './ServerHub.jsx'
import ClipsPage from './ClipsPage.jsx'
import UpdateButton from './UpdateButton.jsx'
import Tooltips from './Tooltips.jsx'
import ProfilePhoto from './ProfilePhoto.jsx'
import ScreenChannel from './ScreenChannel.jsx'

// Lista viva de uma tabela (select inicial + realtime)
function useLive(table, filter, order, deps) {
  const [rows, setRows] = useState(null)
  const current = useRef(null)
  const filterId = filter?.[1]
  useEffect(() => {
    setRows(null)
    if (filter === false) return
    const feed = createLiveRows(() => {
      const q = supabase.from(table).select('*').order(order, { ascending: true })
      return filter ? q.eq(filter[0], filter[1]) : q
    }, setRows)
    current.current = { feed, filterId }
    const apply = event => feed.change(list => applyRowEvent(list, event))
    feed.load()
    const ch = supabase.channel(`live:${table}:${filterId ?? 'all'}:${Math.random().toString(36).slice(2)}`)
    if (filter) {
      for (const event of ['INSERT', 'UPDATE']) ch.on('postgres_changes', {
        event, schema: 'public', table, filter: `${filter[0]}=eq.${filterId}`,
      }, apply)
      // DELETE nao respeita filtro; ids de canais sao unicos.
      ch.on('postgres_changes', { event: 'DELETE', schema: 'public', table }, apply)
    } else ch.on('postgres_changes', { event: '*', schema: 'public', table }, apply)
    ch.subscribe(feed.onStatus)
    return () => {
      feed.close()
      current.current = null
      supabase.removeChannel(ch)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return [rows, update => {
    const source = current.current
    if (source && source.filterId === filterId) source.feed.change(update)
  }]
}

// Carta do centro do deck vira a capa do servidor na lateral: a moldura encolhe
// (geometria real, sem distorcer o raio) enquanto a carta some e a capa aparece.
function coverFlight(move, item) {
  const sidebar = item.closest('.sidebar')
  // A lateral entra deslizando; mede o destino sem esse deslocamento para nao saltar no fim.
  if (sidebar) sidebar.style.animation = 'none'
  const to = item.getBoundingClientRect()
  if (sidebar) { void sidebar.offsetWidth; sidebar.style.animation = '' }
  const from = move.rect
  const flight = document.createElement('div')
  flight.className = 'cover-flight'
  flight.inert = true
  const card = move.card
  card.classList.add('cover-flight-card')
  const face = item.cloneNode(true)
  face.removeAttribute('data-tip')
  face.className = 'cover-flight-face'
  flight.append(card, face)
  document.body.append(flight)
  item.style.visibility = 'hidden'
  const box = (r, radius) => ({ left:r.left+'px', top:r.top+'px', width:r.width+'px', height:r.height+'px', borderRadius:radius })
  const ease = 'cubic-bezier(.32,.72,0,1)'
  const radius = getComputedStyle(item).borderRadius
  const shape = flight.animate([box(from, move.radius), box(to, radius)],
    { duration:620, easing:ease, fill:'forwards' })
  // A arte da carta cresce ate ocupar a moldura inteira (sem margem nem legenda): com foto, a imagem da carta
  // e a da capa ficam no mesmo lugar e a troca entre elas nao mostra duas fotos.
  const morph = { duration:300, easing:ease, fill:'forwards' }
  const cs = getComputedStyle(card)
  card.animate([{ padding:cs.padding, gap:cs.gap }, { padding:'0px', gap:'0px' }], morph)
  for (const el of card.querySelectorAll('.deck-caption,.deck-callroom'))
    el.animate([{ opacity:1, height:el.offsetHeight + 'px', margin:getComputedStyle(el).margin }, { opacity:0, height:'0px', paddingTop:'0px', paddingBottom:'0px', margin:'0px' }], { ...morph, duration:220 })
  const art = card.querySelector('.deck-art')
  if (art) art.animate([{ borderRadius:getComputedStyle(art).borderRadius, borderWidth:'1px' }, { borderRadius:radius, borderWidth:'0px' }], morph)
  card.animate([{ opacity:1 }, { opacity:0 }], { duration:260, delay:260, easing:'cubic-bezier(.4,0,.6,1)', fill:'forwards' })
  face.animate([{ opacity:0 }, { opacity:1 }], { duration:300, delay:200, easing:'cubic-bezier(.22,1,.36,1)', fill:'forwards' })
  const restore = () => { flight.remove(); item.style.visibility = '' }
  shape.onfinish = restore
  return () => { shape.cancel(); restore() }
}

export default function Shell({ profile }) {
  const { serverId, channelId, clips, join } = useRoute()
  const [servers, setServers] = useLive('servers', null, 'created_at', [])
  const [channels, setChannels] = useLive('channels', serverId ? ['server_id', serverId] : false, 'created_at', [serverId])
  const [collapsed, setCollapsed] = useState(false)

  const [editing, setEditing] = useState(false)
  const [serverPhoto, setServerPhoto] = useState(null)
  const [photo, setPhoto] = useState(0)

  const [call, setCall] = useState(null)
  const [connected, setConnected] = useState(false)
  const [unread, setUnread] = useState(0)
  // Mensagens novas: contador no titulo (aba e barra de tarefas) e ponto no icone da aba na web.
  useEffect(() => {
    document.title = unread ? `(${unread > 9 ? '9+' : unread}) Visor` : 'Visor'
    if (window.visor) return
    const link = document.querySelector('link[rel="icon"]')
    if (!link) return
    link.dataset.base ??= link.href
    if (!unread) { link.href = link.dataset.base; return }
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 64
      const g = c.getContext('2d')
      g.drawImage(img, 0, 0, 64, 64)
      g.beginPath(); g.arc(50, 14, 13, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill()
      g.lineWidth = 4; g.strokeStyle = '#0a0a0a'; g.stroke()
      link.href = c.toDataURL('image/png')
    }
    img.src = link.dataset.base
  }, [unread])
  useEffect(() => { if (!call) setUnread(0) }, [call])
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
    // Canal compartilhado (topics.js): reabre sozinho se o servidor fechar e avisa 'SUBSCRIBED' de novo.
    const topic = acquireTopic('calls:' + directoryServer, {
      onSync: state => { if (alive) setVisitors(presenceList(state)) },
      onStatus: status => {
        if (!alive || status !== 'SUBSCRIBED') return
        directory.current = publisher
        publisher.reset()
      },
    })
    let tracked = false
    const payload = () => member.current && { ...member.current, endpointId, profileId: profile.id, device: member.current.device ?? deviceKind }
    const publisher = presencePublisher(() => {
      const dir = topic.channel
      if (!dir || dir.state !== 'joined') return
      if (member.current) {
        tracked = true
        return dir.track(payload())
      }
      if (tracked) return dir.untrack().then(status => {
        if (status === 'ok' && !member.current) tracked = false
        return status
      })
    }, {
      snapshot: () => JSON.stringify(payload() ?? null),
      present: () => { const dir = topic.channel; return !dir || dir.state !== 'joined' ? null : member.current ? endpointId in dir.presenceState() : !tracked },
    })
    // O canal pode seguir aberto para o tabuleiro/radar: a propria presenca sai explicitamente.
    return () => { alive = false; publisher.close(); directory.current = null; if (tracked) topic.channel?.untrack(); topic.release() }
  }, [directoryServer, profile.id])

  const [browsingVisitors, setBrowsingVisitors] = useState([])
  useEffect(() => {
    setBrowsingVisitors([])
    if (!serverId || serverId === directoryServer) return
    let alive = true
    const topic = acquireTopic('calls:' + serverId, { onSync: state => { if (alive) setBrowsingVisitors(presenceList(state)) } })
    return () => { alive = false; topic.release() }
  }, [serverId, directoryServer])
  const roster = new Map()
  for (const visitor of directoryServer === serverId ? visitors : browsingVisitors) {
    const id = visitor.endpointId ?? visitor.id
    if (id !== endpointId) roster.set(id, visitor)
  }
  if (call && call.server_id === serverId) {
    roster.set(endpointId, { id:endpointId, profileId:profile.id, channel:call.id,
      name:profile.username, photo, device:deviceKind,
      sharing:visitors.some(v => (v.endpointId ?? v.id) === endpointId && v.channel === call.id && v.sharing) })
  }
  const listedVisitors = [...roster.values()]
  // Radar do deck: atividade de cada servidor (o da call vem do diretorio que ja esta aberto).
  const radar = useRadar(servers ? servers.map(s => s.id) : [], !serverId)

  const server = servers?.find((s) => s.id === serverId) ?? null
  // Canais ja vistos por servidor: voltar a um servidor mostra as mesas na hora, sem o tabuleiro vazio
  // enquanto a lista recarrega. Agrupa pelo server_id de cada linha (no primeiro render apos trocar de
  // servidor, `channels` ainda guarda as linhas do servidor anterior).
  const channelCache = useRef(new Map())
  if (channels?.length) {
    const groups = Map.groupBy(channels, c => c.server_id)
    for (const [id, rows] of groups) channelCache.current.set(id, rows)
  }
  // No deck, carrega os canais de todos os servidores: a carta pousa e o tabuleiro ja tem as mesas.
  useEffect(() => {
    if (serverId || !servers?.length) return
    let alive = true
    supabase.from('channels').select('*').eq('kind', 'screen').order('created_at', { ascending: true }).then(({ data }) => {
      if (!alive || !data) return
      for (const s of servers) channelCache.current.set(s.id, data.filter(c => c.server_id === s.id))
    })
    return () => { alive = false }
  }, [serverId, servers])
  const cachedChannels = serverId ? channelCache.current.get(serverId) : null
  const knownChannels = channels?.some(c => c.server_id === serverId) || (channels && !channels.length && !cachedChannels) ? channels : cachedChannels ?? channels
  // A call em andamento ja traz o proprio canal: entrar nela nao espera a lista (antes aparecia o tabuleiro vazio).
  const channel = knownChannels?.find((c) => c.kind === 'screen' && c.server_id === serverId && c.id === channelId)
    ?? (call && call.id === channelId && call.server_id === serverId ? call : null)
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
    if (serverId && move.card) return coverFlight(move, item)
    item.scrollIntoView({ block:'nearest', inline:'nearest' })
    const to = item.getBoundingClientRect()
    const from = move.rect
    const ghost = item.cloneNode(true)
    ghost.className = serverId ? 'server-flight' : 'server-flight deck-return'
    ghost.removeAttribute('data-tip')
    ghost.inert = true
    Object.assign(ghost.style, { left:to.left+'px', top:to.top+'px', width:to.width+'px', height:to.height+'px',
      borderRadius:getComputedStyle(item).borderRadius, fontSize:getComputedStyle(item).fontSize })
    document.body.append(ghost)
    const dx = from.x + from.width/2 - to.x - to.width/2
    const dy = from.y + from.height/2 - to.y - to.height/2
    item.style.visibility = 'hidden'
    const frames = [{ transform:`translate(${dx}px,${dy}px) scale(${from.width/to.width})` }]
    if (!serverId) {
      const cx = innerWidth/2 - to.x - to.width/2
      const cy = innerHeight/2 - to.y - to.height/2
      frames.push({ transform:`translate(${cx}px,${cy}px) scale(.55)`, offset:.55 })
    }
    frames.push({ transform:'none' })
    const flight = ghost.animate(frames, {duration:serverId ? 490 : 730, easing:'cubic-bezier(.23,.78,.2,1)'})
    const restore = () => { ghost.remove(); item.style.visibility = '' }
    flight.onfinish = restore
    return () => { flight.cancel(); restore() }
  }, [serverId])
  function openServer(row, node) {
    const previous = document.querySelector('.rail-item.is-active')
    const card = !previous && node?.matches('.deck-center,.deck-callcard') ? node.cloneNode(true) : null
    origin.current = { id:row.id, rect:(previous ?? node).getBoundingClientRect(), card,
      radius:card ? getComputedStyle(node).borderRadius : null }
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

  // Link da sala (#/j/<convite>/<canal>): entra no servidor pelo codigo (ja sendo membro, so confirma) e abre a sala,
  // o que ja entra na call. Espera a lista de servidores carregar (senao a lista inicial apagaria o servidor novo).
  const joining = useRef(null)
  const [joinFailed, setJoinFailed] = useState(0)
  // Chegada pelo link: a sala coloca na mesa a transmissao de quem mandou (ou a primeira ao vivo).
  const [arrival, setArrival] = useState(null)
  useEffect(() => {
    if (!join || !servers) return
    const key = join.code + '/' + join.channelId
    if (joining.current === key) return
    joining.current = key
    submitServer('join', join.code)
      .then(row => { if (join.channelId) setArrival({ channelId: join.channelId, from: join.from, at: Date.now() }); replaceRoute(row.id, join.channelId) })
      .catch(() => { setJoinFailed(Date.now()); play('fail'); replaceRoute(null) })
      .finally(() => { joining.current = null })
  }, [join, !!servers])
  useEffect(() => {
    if (!joinFailed) return
    const t = setTimeout(() => setJoinFailed(0), 2800)
    return () => clearTimeout(t)
  }, [joinFailed])

  const createChannel = async (name) => {
    const { data, error } = await supabase.from('channels').insert({ server_id: serverId, name, kind:'screen' }).select().single()
    if (error) return false
    setChannels((prev) => (prev?.some((c) => c.id === data.id) ? prev : [...(prev ?? []), data]))
    go(serverId, data.id)
    return true
  }

  const deleteServer = async row => {
    const {error} = await supabase.from('servers').delete().eq('id',row.id).eq('owner_id',profile.id).select('id').single()
    if (error) throw error
    setServers(prev => prev.filter(s => s.id !== row.id))
  }

  const leaveServer = async row => {
    const {error} = await supabase.from('server_members').delete().eq('server_id',row.id).eq('profile_id',profile.id).select('server_id').single()
    if (error) throw error
    setServers(prev => prev.filter(s => s.id !== row.id))
  }

  const renameServer = async name => {
    const {data,error} = await supabase.from('servers').update({name}).eq('id',server.id).eq('owner_id',profile.id).select().single()
    if (error) return false
    setServers(rows => rows.map(row => row.id === data.id ? data : row))
    return true
  }

  const deleteChannel = async (id) => {
    const { error } = await supabase.from('channels').delete().eq('id', id).select('id').single()
    if (error) return
    setChannels((prev) => prev.filter((c) => c.id !== id))
    const cached = channelCache.current.get(serverId)
    if (cached) channelCache.current.set(serverId, cached.filter(c => c.id !== id))
    if (id === channelId) go(serverId)
  }

  const logout = async () => {
    await supabase.auth.signOut()
  }

  function disconnect() {
    // Mede a mesa da sala antes de sair: o tabuleiro encolhe exatamente dela ate a mesa do canal.
    const felt = document.querySelector('.call-session:not([hidden]) .table-felt')?.getBoundingClientRect()
    returnRect.current = felt ? { left: felt.left, top: felt.top, width: felt.width, height: felt.height } : null
    if (channel) go(serverId) // o tabuleiro toca a volta (sala encolhe ate a mesa)
    else play('exit')
    setCall(null)
  }
  // Som ao entrar numa call (o tabuleiro ja toca o seu durante a animacao da mesa).
  const boardJoin = useRef(false)
  const lastCall = useRef(null)
  useEffect(() => {
    if (call && call.id !== lastCall.current && !boardJoin.current) play('enter')
    boardJoin.current = false
    lastCall.current = call?.id ?? null
  }, [call?.id])
  // Volta ao tabuleiro: lembra de qual mesa voce saiu para a animacao de retorno.
  const prevRoute = useRef({ serverId, channelId })
  const returnRect = useRef(null)
  const [returning, setReturning] = useState(null)
  // Trocar de tela (deck, tabuleiro, canal) muda a grade de uma vez: a transicao da coluna lateral deslocava
  // o conteudo durante as animacoes (a carta mirava a capa no lugar antigo). So recolher a lateral anima.
  const [snap, setSnap] = useState(false)
  useLayoutEffect(() => {
    const prev = prevRoute.current
    setReturning(prev.serverId === serverId && prev.channelId && !channelId ? { id: prev.channelId, rect: returnRect.current } : null)
    returnRect.current = null
    prevRoute.current = { serverId, channelId }
    setSnap(true)
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setSnap(false)))
    return () => cancelAnimationFrame(id)
  }, [serverId, channelId])
  const callVisible = Boolean(call && call.id === channel?.id)
  const callLabel = call ? (connected ? 'Conectado' : 'Conectando…') : 'Desconectado'

  return (
    <div className={`shell ${!serverId ? 'in-hub' : ''} ${server && !channel ? 'is-board' : ''} ${collapsed ? 'is-collapsed' : ''} ${snap ? 'snap' : ''}`}>
      <UpdateButton/>
      <Tooltips/>
      {serverPhoto && <ProfilePhoto server={serverPhoto} saved={revision =>
        setServers(rows => rows.map(row => row.id === serverPhoto.id ? {...row,photo_revision:revision} : row))}
        close={() => setServerPhoto(null)}/>}
      {editing && <ProfilePhoto profile={profile} saved={setPhoto} close={() => setEditing(false)} />}
      {server && channel && <aside className="sidebar" aria-label="Canais">

            <ServerHeader key={server.id} server={server} owner={isOwner} back={e=>openServer(server,e.currentTarget)}
              editPhoto={()=>setServerPhoto(server)} rename={renameServer} createChannel={createChannel}/>
            <PillList
              className="channel-list"
              items={knownChannels?.filter(c => c.server_id === serverId && c.kind === 'screen') ?? []}
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
                  <ChannelCrowd people={listedVisitors.filter(v => v.channel === c.id)} label={c.name} onOpen={() => go(serverId, c.id)}/>

                </div>
              )}
            />
            <div className="side-foot account-foot">
          {call ? <CallCard call={call} server={servers?.find(x => x.id === call.server_id)} connected={connected}
            live={listedVisitors.some(v => (v.endpointId ?? v.id) === endpointId && v.sharing)} here={callVisible} unread={unread}
            onOpen={() => go(call.server_id, call.id)} onLeave={disconnect}/> : <span className="foot-idle"/>}
              <ProfileMenu profile={profile} photo={photo} edit={()=>setEditing(true)} logout={logout}/>
            </div>
      </aside>}

      <main className="main">
        {server && channel && <header className="main-head">
          <IconButton label={collapsed ? 'Expandir' : 'Recolher'} onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.75} /> : <PanelLeftClose size={16} strokeWidth={1.75} />}
          </IconButton>
          {channel && (
            <div className="main-title" key={channel.id}>
              <Cast size={16} strokeWidth={1.75}/>
              <span>{channel.name}</span>
            </div>
          )}
          {server.invite_code && <CopyButton text={roomLink(server.invite_code, channel.id, profile.id)} label="Link da sala" icon={Link2}/>}
          <div id="call-head-slot" className="head-slot"/>
        </header>}
        <div className="main-body">
          {join && <div className="boot"><span className="boot-dot"/></div>}
          {joinFailed > 0 && createPortal(<div className="clip-toast join-fail" role="status" key={joinFailed}><TriangleAlert size={14} strokeWidth={2}/>Convite inválido</div>, document.body)}
          {!serverId && clips && window.visor?.clips && <ClipsPage onBack={() => go(null)}/>}
          {!serverId && !join && !(clips && window.visor?.clips) && servers && <ServerHub call={call ? { server:servers.find(s => s.id === call.server_id), name:call.name, connected,
              live:visitors.some(v => (v.endpointId ?? v.id) === endpointId && v.channel === call.id && v.sharing) } : null}
            onResume={node => { const row = servers.find(s => s.id === call?.server_id); if (row) openServer(row, node) }} onHangup={disconnect}
            activity={radar} ownerId={profile.id} onDelete={deleteServer} onLeave={leaveServer} returningId={origin.current?.id} servers={servers} onSubmit={submitServer} onOpen={openServer} editProfile={() => setEditing(true)} logout={logout}/>}
          {server && !channel && <ServerBoard key={server.id} server={server} owner={isOwner} returning={returning}
            channels={knownChannels?.filter(c => c.kind === 'screen' && c.server_id === serverId) ?? []}
            people={listedVisitors} me={{ id: endpointId, profileId: profile.id, name: profile.username, photo }}
            header={<ServerHeader server={server} owner={isOwner} back={e => openServer(server, e.currentTarget)}
              editPhoto={() => setServerPhoto(server)} rename={renameServer} createChannel={createChannel}/>}
            profileMenu={<ProfileMenu profile={profile} photo={photo} edit={() => setEditing(true)} logout={logout}/>}
            callCard={call && call.server_id !== serverId ? <CallCard call={call} server={servers?.find(x => x.id === call.server_id)} connected={connected}
              live={visitors.some(v => (v.endpointId ?? v.id) === endpointId && v.sharing)} here={false} unread={unread}
              onOpen={() => go(call.server_id, call.id)} onLeave={disconnect}/> : null}
            onJoin={c => { boardJoin.current = call?.id !== c.id; go(serverId, c.id) }}
            onCreate={createChannel} onDelete={deleteChannel}/>}
          {call && <div className="call-session" hidden={!callVisible}>
            <ScreenChannel key={call.id} channel={call} profile={profile} chatChannel={call} visible={callVisible} onUnread={setUnread}
              onConnection={setConnected} reportMember={reportMember} visitors={visitors.filter(v => v.channel === call.id)} photo={photo}
              arrival={arrival?.channelId === call.id ? arrival : null} onArrived={() => setArrival(null)}/>
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
        <button className="mini-go" disabled={!name.trim() || busy} aria-label="Confirmar">
          {children}
        </button>
      </div>
    </form>
  )
}

function ServerHeader({server,owner,back,editPhoto,rename,createChannel}) {
  const pop = usePopover()
  const [mode,setMode] = useState(null)
  function open() { setMode(null); pop.setOpen(true) }
  return <header ref={pop.ref} className="server-header">
    <button className="server-cover rail-item is-active" onClick={back} data-tip="Voltar ao deck" aria-label="Voltar ao deck"
      onContextMenu={e=>{e.preventDefault();open()}}><ServerFace server={server}/></button>
    <button className="server-options" aria-label="Opções do servidor" aria-expanded={pop.open} onClick={()=>pop.open?pop.setOpen(false):open()}><MoreHorizontal size={17}/></button>
    <h1>{server.name}</h1>
    {pop.open && <div className="sidebar-menu">
      {mode ? <NameForm key={mode} max={mode==='rename'?32:24} placeholder={mode==='rename'?'Nome do servidor':'Nome do canal'}
        onSubmit={async v=>{const ok=await (mode==='rename'?rename:createChannel)(v);if(ok)pop.setOpen(false);return ok}}><ArrowRight size={15}/></NameForm> :
        <>{owner && <><button onClick={()=>{pop.setOpen(false);editPhoto()}}><ImagePlus size={16}/>Trocar foto</button>
        <button onClick={()=>setMode('rename')}><Pencil size={16}/>Trocar nome</button></>}
        <div className="invite-action"><CopyButton text={server.invite_code} label="Copiar código"/><span>Copiar código</span></div>
        {owner && <button onClick={()=>setMode('channel')}><Cast size={16}/>Criar canal</button>}</>}
    </div>}
  </header>
}

function ProfileMenu({profile,photo,edit,logout}) {
  const pop = usePopover()
  return <div className="profile-menu" ref={pop.ref}>
    <button aria-label="Menu do perfil" aria-expanded={pop.open} data-tip={profile.username} onClick={()=>pop.setOpen(!pop.open)}>
      <Avatar id={profile.id} revision={photo} name={profile.username} size={38}/>
    </button>
    {pop.open && <div className="sidebar-menu"><button onClick={()=>{pop.setOpen(false);edit()}}><ImagePlus size={16}/>Trocar foto</button>
      <SoundToggle size={16}/>
      <button onClick={logout}><LogOut size={16}/>Sair da conta</button></div>}
  </div>
}

// Lateral: quem transmite num canal vira um mini leque de cartas; quem assiste, avatares pequenos.
function ChannelCrowd({ people, label, onOpen }) {
  if (!people.length) return null
  const live = people.filter(p => p.sharing), crowd = people.filter(p => !p.sharing)
  return <button className="channel-crowd" aria-label={`${people.length} em ${label}`} onClick={onOpen}>
    {!!live.length && <span className="mini-hand" style={{ '--n': live.length }}>{live.slice(0, 5).map((p, i) =>
      <span key={p.endpointId ?? p.id} className="mini-card" data-tip={p.name} style={{ '--d': i - (Math.min(live.length, 5) - 1) / 2 }}>
        <Avatar id={p.profileId ?? p.id} revision={p.photo} name={p.name} size={18}/><i className="live-dot"/>
      </span>)}</span>}
    {!!crowd.length && <span className="mini-crowd">{crowd.slice(0, 4).map(p =>
      <span key={p.endpointId ?? p.id} data-tip={p.name}><Avatar id={p.profileId ?? p.id} revision={p.photo} name={p.name} size={20}/></span>)}
      {crowd.length > 4 && <small>+{crowd.length - 4}</small>}</span>}
    <span className="crowd-count">{live.length ? `${live.length} ao vivo` : `${people.length}`}</span>
  </button>
}

// Rodape: a call em andamento vira uma carta deitada (pulsa quando voce esta ao vivo).
function CallCard({ call, server, connected, live, here, unread, onOpen, onLeave }) {
  return <div className={'call-card' + (live ? ' is-live' : '') + (connected ? '' : ' is-connecting') + (here ? ' is-here' : '')}>
    <button className="call-card-main" onClick={onOpen} aria-label={'Voltar para ' + call.name} data-tip={here ? call.name : 'Voltar para a call'}>
      <span className="call-card-face">{server ? <ServerFace server={server}/> : <Cast size={14}/>}</span>
      <span className="call-card-text"><b>{call.name}</b><small>{live ? 'ao vivo' : connected ? 'na call' : 'conectando'}</small></span>
      {unread > 0 ? <span className="call-card-unread" aria-label={unread + ' mensagens novas'}><MessageSquare size={12}/>{unread > 9 ? '9+' : unread}</span> : <i className="live-dot"/>}
    </button>
    <button className="call-card-leave" aria-label="Desconectar" data-tip="Desconectar" onClick={onLeave}><PhoneOff size={14}/></button>
  </div>
}
