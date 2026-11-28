import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, Camera, CameraOff, Check, ChevronRight, Clapperboard, Eye, Maximize, MessageSquare, Minimize, Minus, Monitor, SquareArrowOutUpRight, MonitorUp, Smartphone, Square, Volume2, VolumeX, X } from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { deviceKind, endpointId } from '../lib/presence.js'
import { ScreenRoom } from '../lib/screen.js'
import { fmtMbps, getPreset } from '../lib/quality.js'
import { desktop } from '../lib/env.js'
import { captureDesktop, captureDevice, captureWeb } from '../lib/sources.js'
import { Avatar, IconButton } from './ui.jsx'
import SharePanel, { exeKey, pref, screenCaptureSupported, useCameras, useShareConfig } from './SharePanel.jsx'
import CardTable from './CardTable.jsx'
import MiniPlayer, { miniDesktop, miniPlayerSize, openMiniWindow, prepareMini } from './MiniPlayer.jsx'
import { ReplayBuffer, replaySupported } from '../lib/replay.js'
import { AppAudioMixer } from '../lib/appAudio.js'
import { useAsciiField } from '../lib/useAsciiField.js'
import { play } from '../lib/sound.js'
import { enterFullscreen, exitFullscreen, watchFullscreen } from '../lib/fullscreen.js'
import TextChannel from './TextChannel.jsx'

let selfPid = 0
if (desktop) window.visor.selfPid().then((p) => (selfPid = p))

// Converte a configuracao de audio em alvos do helper nativo:
// - Mudo: nada
// - Tudo sem exclusoes: um fluxo do sistema inteiro menos o proprio Visor (sem eco)
// - Tudo com exclusoes: um fluxo por app que NAO esta excluido (a API do Windows so exclui 1 processo por fluxo)
function audioTargets(cfg, apps) {
  if (cfg.audioMode === 'off') return []
  if (!cfg.exclude.length) return [{ pid: selfPid, exclude: true }]
  return apps.filter((a) => !cfg.exclude.includes(exeKey(a.exe))).map((a) => ({ pid: a.pid, exclude: false }))
}

// Apps com audio (desktop), atualizado a cada 3 s enquanto precisa
function useAudioApps(enabled) {
  const [apps, setApps] = useState([])
  useEffect(() => {
    if (!desktop || !enabled) return
    let alive = true
    const load = () => window.visor.audioApps().then((a) => alive && setApps(a))
    load()
    const t = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [enabled])
  return apps
}

export default function ScreenChannel({ channel, profile, chatChannel, visitors = [], photo, reportMember, visible = true, onConnection, onUnread, arrival, onArrived }) {
  const roomRef = useRef(null)
  const captureRef = useRef(null)
  const starting = useRef(false)
  const [arrivalTick, setArrivalTick] = useState(0)
  const [s, setS] = useState({ peers: [], sharing: false, local: null, remote: null, watching: null, viewers: 0, preset: '1080p60', bitrate: 0, uplink: null, stats: null, remoteAudio: false })
  useEffect(() => { onConnection?.(Boolean(s.connected)) }, [s.connected, onConnection])
  useEffect(() => {
    if (!visible) { setHover(null); setMenu(null) }
  }, [visible])
  const [hover, setHover] = useState(null)
  const hoverTimer = useRef(null)
  const [menu, setMenu] = useState(null)
  // Celular: o chat comeca fechado (cobriria a transmissao) e a escolha fica salva separada da do computador.
  const [chatKey] = useState(() => matchMedia('(max-width: 600px)').matches ? 'visor.chatOpenMobile' : 'visor.chatOpen')
  const [chat, setChat] = useState(() => pref.get(chatKey, chatKey === 'visor.chatOpen'))
  const [toasts, setToasts] = useState([])
  const [unread, setUnread] = useState(0)
  // Mensagens da call: gota ao chegar; sem o chat a vista (fechado, outra tela ou janela sem foco) conta
  // como nao lida, aparece sobre a mesa e avisa o Shell (titulo, icone da aba, carta da call, barra de tarefas).
  const seenRef = useRef(false)
  seenRef.current = chat && visible
  useEffect(() => {
    if (!chatChannel) return
    const sub = supabase.channel(`chat-peek:${chatChannel.id}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${chatChannel.id}` }, ({ new: m }) => {
        if (m.author_id === profile.id) return
        const seen = seenRef.current && document.hasFocus()
        play('drop', { gain: seen ? 0.55 : 1 })
        if (seen) return
        setUnread(n => n + 1)
        window.visor?.attention?.()
        if (!chat && visible) {
          setToasts(t => [...t.slice(-2), { id: m.id, name: m.author_name, body: m.body }])
          setTimeout(() => setToasts(t => t.filter(x => x.id !== m.id)), 6000)
        }
      }).subscribe()
    return () => { supabase.removeChannel(sub) }
  }, [chatChannel?.id, profile.id, chat, visible])
  useEffect(() => {
    const clear = () => { if (seenRef.current && document.hasFocus()) { setUnread(0); setToasts([]) } }
    clear()
    addEventListener('focus', clear)
    return () => removeEventListener('focus', clear)
  }, [chat, visible])
  useEffect(() => { onUnread?.(unread) }, [unread, onUnread])
  const [cfg, update] = useShareConfig()
  const [error, setError] = useState(false)
  const [nativeCapture, setNativeCapture] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false) // painel de transmitir (a carta + aberta)
  const [panelMode, setPanelMode] = useState('screen') // 'screen' | 'device' (comecar) | 'settings' (Ajustes ao vivo) | 'camera' (camera junto com a tela)
  const [camOut, setCamOut] = useState(() => new Set()) // ids cuja camera esta na mesa como carta propria
  // Parar desliga tambem a camera que ia junto (a proxima transmissao comeca sem ela).
  const stopShare = () => { roomRef.current.stopShare(); captureRef.current = null; update({ camId: null }); play('stop') }
  const [ownOnTable, setOwnOnTable] = useState(true)
  const [pip, setPip] = useState(null) // { id, win } transmissao no miniplayer
  const placedAt = useRef(new Map())
  // Campo ASCII leve no fundo da sala (6 fps parado); para enquanto voce transmite ou com a sala fora da tela.
  const fieldCanvas = useRef(null)
  useAsciiField(fieldCanvas, { light: true, paused: s.sharing || !visible, background: t => t.matches?.('.card-table, .table-felt.is-empty, .table-slot, .hand') })
  // Camera junto com a tela: abre so enquanto transmite; trocar no painel vale ao vivo, sem reconectar ninguem.
  const camWanted = s.sharing && cfg.camId && !(cfg.kind === 'device' && cfg.camId === cfg.deviceId) ? cfg.camId : null
  useEffect(() => { roomRef.current?.setCamera(camWanted) }, [camWanted])
  const needsAudioApps = cfg.kind !== 'device' && (panelOpen || (s.sharing && cfg.audioMode === 'all' && cfg.exclude.length > 0))
  const apps = useAudioApps(needsAudioApps)
  const targetKey = JSON.stringify(audioTargets(cfg, apps))

  useEffect(() => {
    if (!desktop || !window.visor.captureAvailable || typeof MediaStreamTrackGenerator !== 'function') return
    let mounted = true
    window.visor.captureAvailable().then((available) => mounted && setNativeCapture(available)).catch(() => {})
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    const room = new ScreenRoom({ supabase, roomId: channel.id, me: { id: endpointId, profileId: profile.id, name: profile.username, device: deviceKind }, onChange: setS })
    roomRef.current = room
    if (import.meta.env.DEV) window.__room = room // depuracao: window.__room.out / .inPc
    room.join()
    return () => room.leave()
  }, [channel.id, profile.id, profile.username])

  // Replay (F9): no ar com o replay ligado, guarda os ultimos segundos; F9 (atalho global) salva o clipe
  // em Videos\Visor Clips com miniatura. Desliga junto com a transmissao.
  const [clipSaved, setClipSaved] = useState(null)
  const replayOn = desktop && !!window.visor?.clips && !!cfg.replay && s.sharing && !!s.local && replaySupported()
  // O clipe sempre tem som: transmitindo no Mudo (ou sem audio), o replay grava o som do sistema (menos o
  // proprio Visor) num mixer so dele; os espectadores continuam sem audio.
  const replayOwnAudio = replayOn && (cfg.kind === 'device' ? !s.local?.getAudioTracks().length : cfg.audioMode === 'off')
  useEffect(() => {
    if (!replayOn) return
    let mixer = null, closed = false
    const source = replayOwnAudio ? new MediaStream(s.local.getVideoTracks()) : s.local
    const buffer = new ReplayBuffer(source, { seconds: cfg.replay, fps: getPreset(cfg.presetId).fps }).start()
    if (replayOwnAudio) window.visor.audioSupported().then(ok => {
      if (!ok || closed) return
      mixer = new AppAudioMixer(1)
      return mixer.set([{ pid: selfPid, exclude: true }]).then(() => { if (closed) mixer.close(); else buffer.addTrack(mixer.track) })
    }).catch(() => {})
    let saving = false, hide
    window.visor.replayArm(true)
    const off = window.visor.onReplaySave(async () => {
      if (saving) return
      saving = true
      try {
        const clip = await buffer.save()
        if (!clip?.data?.byteLength) return
        const saved = await window.visor.clips.save({ data: clip.data, thumb: clip.thumb, ext: clip.ext, meta: { duration: clip.duration, source: channel.name } })
        if (!saved) return
        play('chime')
        clearTimeout(hide)
        setClipSaved({ duration: clip.duration, at: Date.now() })
        hide = setTimeout(() => setClipSaved(null), 2600)
      } finally { saving = false }
    })
    return () => { closed = true; off(); clearTimeout(hide); window.visor.replayArm(false); buffer.stop(); mixer?.close() }
  }, [replayOn, replayOwnAudio, s.local, cfg.replay, channel.id])

  // Ping na propria transmissao com a previa fora da mesa: ao menos o som avisa quem transmite.
  const ownShown = useRef(true)
  ownShown.current = s.sharing && ownOnTable
  useEffect(() => roomRef.current.onPing(p => {
    if (p.stream === endpointId && !p.mine && !ownShown.current) play('drop', { gain: .6 })
  }), [channel.id])

  useEffect(() => {
    const room = roomRef.current
    room.me.photo = photo
    if (room.channel) room.track()
  }, [photo, channel.id])

  const watchingKey = JSON.stringify((s.inputs ?? []).filter(v => !v.preview).map(v => v.id))
  const ownPeer = s.peers.find(p => p.id === endpointId)
  const activeShareId = ownPeer?.shareId ?? roomRef.current?.shareId ?? null
  useEffect(() => {
    reportMember?.({ channel: channel.id, name: profile.username, photo, device: deviceKind, sharing: s.sharing, shareId: activeShareId, watching: JSON.parse(watchingKey) })
    return () => reportMember?.(null)
  }, [channel.id, profile.username, photo, s.sharing, activeShareId, watchingKey, reportMember])
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const hidePreview = () => { clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => setHover(null), 220) }

  useEffect(() => {
    if (!menu) return
    const dismiss = e => { if (e.type !== 'keydown' || e.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('blur', dismiss)
    window.addEventListener('keydown', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('keydown', dismiss)
    }
  }, [menu])

  useEffect(() => {
    if (!hover) return
    const room = roomRef.current
    const timer = setTimeout(() => room.watch(hover.id, true, hover.peer), 300)
    return () => {
      clearTimeout(timer)
      if (room.inputs.get(hover.id)?.preview) room.stopWatching(hover.id)
    }
  }, [hover])

  useEffect(() => { if (s.sharing) setOwnOnTable(true) }, [s.sharing])

  // Sons da sala: entrou, saiu, comecou a transmitir. Ignora a primeira leitura ao entrar.
  const roster = useRef(null)
  const settleAt = useRef(Date.now() + 2000)
  useEffect(() => {
    const now = new Map(s.peers.filter(p => p.id !== endpointId).map(p => [p.id, !!p.sharing]))
    const before = roster.current
    roster.current = now
    if (!before || !visible || Date.now() < settleAt.current) return
    let sound = null
    for (const [id, sharing] of now) {
      if (!before.has(id)) sound = sharing ? 'chime' : sound ?? 'join'
      else if (sharing && !before.get(id)) sound = 'chime'
    }
    if (!sound) for (const id of before.keys()) if (!now.has(id)) sound = 'leave'
    if (sound) play(sound)
  }, [s.peers, visible])

  // Desktop: reduz a disputa por CPU/GPU enquanto transmite.
  useEffect(() => {
    if (!desktop || !window.visor.boost || !s.sharing) return
    window.visor.boost(true).catch(() => {})
    return () => { window.visor.boost(false).catch(() => {}) }
  }, [s.sharing])

  // Ao vivo: aplica mudancas de qualidade, bitrate e audio sem reiniciar
  useEffect(() => {
    if (s.sharing) roomRef.current.setPreset(cfg.presetId)
  }, [cfg.presetId, s.sharing])
  useEffect(() => {
    if (s.sharing) roomRef.current.setBitrate(cfg.bitrate)
  }, [cfg.bitrate, s.sharing])
  useEffect(() => {
    if (s.sharing) captureRef.current?.mixer?.set(JSON.parse(targetKey))
  }, [targetKey, s.sharing])
  useEffect(() => {
    if (s.sharing) captureRef.current?.setAudioGain?.(cfg.audioGain ?? 1.5)
  }, [cfg.audioGain, s.sharing])

  const start = async () => {
    if (starting.current) return false
    starting.current = true
    const room = roomRef.current
    const preset = getPreset(cfg.presetId)
    const gain = cfg.audioGain ?? 1.5
    try {
      let cap
      if (cfg.kind === 'device') {
        if (!cfg.deviceId) throw new Error('device')
        cap = await captureDevice(cfg.deviceId, preset, cfg.deviceAudioId, gain)
      } else if (desktop) {
        if (!cfg.sourceId) throw new Error('source')
        const engine = nativeCapture && cfg.engine === 'rust' ? 'rust' : 'chromium'
        const hasNativeAudio = await window.visor.audioSupported().catch(() => false)
        cap = await captureDesktop(cfg.sourceId, preset, hasNativeAudio ? audioTargets(cfg, apps) : [], engine, gain)
      } else {
        cap = await captureWeb(cfg.kind, preset, cfg.audioMode === 'all', gain)
      }
      if (!(await room.startShare(cap, cfg.presetId, cfg.bitrate))) return false
      play('live')
      captureRef.current = cap
      return true
    } catch (err) {
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        console.warn('[visor] captura', err)
        setError(desktop && cfg.engine === 'rust' && cfg.kind !== 'device'
          ? 'Falha na captura Rust. Confira a fonte ou escolha Chromium em Motor de captura.'
          : 'Falha na captura. Selecione a fonte novamente.')
      }
      return false
    } finally {
      starting.current = false
    }
  }

  const inputs = s.inputs ?? []
  // Camera de quem transmite: mini camera sobre a tela (padrao) ou carta propria na mesa (id '<pessoa>:cam').
  // A carta da camera fica na mao enquanto nao esta na mesa; soltar na mao volta a mini camera.
  const camId = id => id + ':cam'
  const camOf = id => id.endsWith(':cam') ? id.slice(0, -4) : null
  const screenTiles = inputs.filter(input => !input.preview)
  if (s.sharing && ownOnTable) screenTiles.unshift({ id: endpointId, stream: s.local, cam: s.camLocal })
  const ownCam = s.sharing ? s.camLocal : null
  const cams = [
    ...(ownCam ? [{ id: endpointId, stream: ownCam }] : []),
    ...inputs.filter(v => !v.preview && v.cam).map(v => ({ id: v.id, stream: v.cam })),
  ]
  const allTiles = screenTiles.flatMap(t => {
    if (!camOut.has(t.id) || !t.cam) return [t]
    return [{ ...t, cam: null }, { id: camId(t.id), camOf: t.id, stream: t.cam }]
  })
  // Camera propria na mesa mesmo com a propria tela fora dela
  if (ownCam && camOut.has(endpointId) && !allTiles.some(t => t.id === camId(endpointId))) allTiles.push({ id: camId(endpointId), camOf: endpointId, stream: ownCam })
  const camHand = cams.filter(c => !camOut.has(c.id))
  useEffect(() => {
    // Camera desligada (ou a pessoa saiu): a carta da camera some da mesa.
    const on = new Set(cams.map(c => c.id))
    if ([...camOut].some(id => !on.has(id))) setCamOut(prev => new Set([...prev].filter(id => on.has(id))))
  }, [cams.map(c => c.id).join(','), camOut])
  const setCamOnTable = (id, on) => setCamOut(prev => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next })
  // Miniplayer: a transmissao sai da mesa mas continua sendo recebida; na mao fica uma carta indicando onde ela esta.
  // pip = { id, win, mode: 'card' | 'player', phase: 'drag' | 'open' }. 'drag': a janela segue o cursor enquanto a
  // carta e arrastada para fora do app (a transmissao ainda e da mesa); 'open': solta fora, virou player.
  const pipTile = pip && allTiles.find(t => t.id === pip.id)
  const pipOpen = pip?.phase === 'open' ? pipTile : null
  const tiles = allTiles.filter(t => t !== pipOpen)
  useEffect(() => { if (pip && !pipTile) setPip(null) }, [pip, !!pipTile])
  const pipRef = useRef(pip)
  pipRef.current = pip
  const dragOut = useRef(null)
  const [ghost, setGhost] = useState(null)
  const tableApi = useRef(null)
  const ratioOf = id => {
    const v = allTiles.find(t => t.id === id)?.stream?.getVideoTracks()[0]?.getSettings()
    return v?.width && v?.height ? v.width / v.height : 16 / 9
  }
  const nameOf = id => camOf(id) ? nameOf(camOf(id)) : id === endpointId ? 'você' : allPeers.find(p => p.id === id)?.name ?? ''
  const cardSize = () => { const w = document.querySelector('.hand-card')?.offsetWidth || 84; return { w, h: Math.round(w * 1.34) } }
  // Desktop: a carta saindo pela borda vira a janela do miniplayer sob o cursor (preparada antes, perto da borda).
  async function pipDrag(type, id, info) {
    const mini = window.visor.mini
    if (type === 'prepare') { prepareMini(); return }
    if (type === 'out') {
      dragOut.current = { id }
      const win = await prepareMini()
      if (!win || dragOut.current?.id !== id) return false
      if (!pipRef.current) setPip({ id, win, mode: 'card', phase: 'drag' })
      mini.follow({ fx: .5, fy: .5, w: info.w, h: info.h, jump: true })
      // Mostra depois que a carta foi desenhada na janela (o React precisa de um quadro).
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      if (dragOut.current?.id !== id) return false
      mini.show()
      return true
    } else if (type === 'in') {
      dragOut.current = null
      mini.hide()
    } else if (type === 'cancel') {
      dragOut.current = null
      // A janela preparada (escondida) fica para o proximo arrasto; com a carta ja na janela, ela fecha.
      if (pipRef.current?.phase === 'drag') { mini.hide(); setPip(null) }
    }
  }
  // Soltou a transmissao fora da mesa: no desktop a carta (janela) cresce ate o player onde foi solta.
  const openPip = id => {
    const p = pipRef.current, size = miniPlayerSize(ratioOf(id))
    play('open')
    if (miniDesktop && p?.phase === 'drag' && p.win && !p.win.closed) {
      dragOut.current = null
      setPip({ ...p, mode: 'player', phase: 'open' })
      window.visor.mini.unfollow().then(() => window.visor.mini.resize({ ...size, anchor: 'grab' }))
      return
    }
    if (miniDesktop) {
      prepareMini().then(win => {
        if (!win) return
        setPip({ id, win, mode: 'player', phase: 'open' })
        window.visor.mini.place({ ...size, atCursor: true })
        window.visor.mini.show()
      })
      return
    }
    openMiniWindow(ratioOf(id)).then(win => setPip({ id, win, mode: 'player', phase: 'open' }), () => setPip({ id, win: null, mode: 'player', phase: 'open' }))
  }
  // O miniplayer foi arrastado de volta para cima do app e solto: vira carta na mesa (ou volta para a mao).
  const pipDropInside = c => {
    const p = pipRef.current
    setGhost(null)
    if (!p || !pipTile) return
    const where = tableApi.current?.dropGhost(p.id, c.x, c.y, pipTile.stream, nameOf(p.id)) ?? 'table'
    if (where === 'hand') { if (camOf(p.id)) setCamOnTable(camOf(p.id), false); else if (p.id === endpointId) setOwnOnTable(false); else roomRef.current.stopWatching(p.id) }
    else placedAt.current.set(p.id, Date.now())
    setPip(null)
  }
  const toggle = (id, peerHint = null) => {
    const room = roomRef.current
    if (room.inputs.has(id) && !room.inputs.get(id).preview) room.stopWatching(id)
    else room.watch(id, false, peerHint)
    setHover(null)
    setMenu(null)
  }
  // Unifica peers da sala com visitors do diretorio para que participantes nunca sumam durante reconexao ou entrada
  const peerMap = new Map()
  for (const v of visitors) {
    const key = v.endpointId ?? v.id
    if (key) peerMap.set(key, { ...v, id: key })
  }
  for (const p of s.peers) {
    const key = p.endpointId ?? p.id
    const prev = peerMap.get(key)
    peerMap.set(key, prev ? { ...prev, ...p, id: key } : { ...p, id: key })
  }
  const allPeers = [...peerMap.values()]

  // Chegou pelo link da sala: poe na mesa a transmissao de quem mandou o link. Se essa pessoa ainda nao esta no ar,
  // espera ate 30 s; se outra pessoa ja esta transmitindo, assiste essa depois de 4 s (tempo da presenca chegar).
  const liveKey = allPeers.filter(p => p.sharing && p.id !== endpointId).map(p => p.id + ':' + p.profileId).join(',')
  useEffect(() => {
    if (!arrival) return
    const done = () => onArrived?.()
    const live = allPeers.filter(p => p.sharing && p.id !== endpointId)
    const age = Date.now() - arrival.at
    const target = live.find(p => arrival.from && p.profileId === arrival.from) ?? (!arrival.from || age > 4000 ? live[0] : null)
    if (target) {
      placedAt.current.set(target.id, Date.now())
      if (!roomRef.current.inputs.has(target.id) || roomRef.current.inputs.get(target.id).preview) roomRef.current.watch(target.id, false, target)
      done()
      return
    }
    // Reavalia quando a lista de quem transmite muda ou quando o prazo de 4 s / 30 s passa.
    const wait = age < 4000 ? 4000 - age : 30000 - age
    if (wait <= 0) { done(); return }
    const t = setTimeout(() => { if (age >= 4000) done(); else setArrivalTick(n => n + 1) }, wait)
    return () => clearTimeout(t)
  }, [arrival, liveKey, arrivalTick])


  return (
    <div className={`screen ${chat && chatChannel ? 'with-chat' : ''}`}>
      <div className="stage-wrap with-table">
        <canvas ref={fieldCanvas} className="room-field" aria-hidden/>
        <CardTable
          tiles={tiles.map(tile => {
            const pid = tile.camOf ?? tile.id
            const peer = allPeers.find(p => p.id === pid)
            if (!placedAt.current.has(tile.id)) placedAt.current.set(tile.id, Date.now())
            const name = pid === endpointId ? 'você' : peer?.name ?? ''
            return { ...tile, own: pid === endpointId, name: tile.camOf ? name + ' · câmera' : name, since: placedAt.current.get(tile.id) }
          })}
          hand={[
            ...(pipOpen ? [{ id: pipOpen.id, pip: true, own: pipOpen.id === endpointId, name: pipOpen.id === endpointId ? profile.username : nameOf(pipOpen.id), device: allPeers.find(p => p.id === pipOpen.id)?.device ?? deviceKind }] : []),
            ...(s.sharing && !ownOnTable ? [{ id: endpointId, own: true, name: profile.username, profileId: profile.id, photo, device: deviceKind }] : []),
            ...camHand.filter(c => pipOpen?.id !== camId(c.id)).map(c => {
              const peer = allPeers.find(p => p.id === c.id)
              return { id: camId(c.id), cam: true, own: c.id === endpointId, name: c.id === endpointId ? profile.username : peer?.name ?? '', peek: c.stream }
            }),
            ...allPeers.filter(p => p.sharing && p.id !== endpointId && !allTiles.some(t => t.id === p.id)).map(p => ({
              ...p, peek: hover?.id === p.id ? inputs.find(v => v.id === p.id)?.stream ?? null : null,
            })),
          ]}
          visible={visible}
          audience={allPeers.filter(p => !p.sharing)}
          toasts={toasts}
          onToast={() => { setChat(true); pref.set(chatKey, true) }}
          adds={[
            // Duas cartas brancas: Tela (tela/janela) e Camera (cameras e placas de captura). A Tela some quando a tela
            // esta no ar; a Camera fica e liga a camera junto com a tela. Transmitindo a propria camera, nenhuma aparece.
            ...(!s.sharing && screenCaptureSupported() ? [{ key: 'screen', label: 'Tela', icon: <MonitorUp size={22} strokeWidth={1.5}/> }] : []),
            ...(!s.sharing || cfg.kind !== 'device' ? [{ key: 'camera', label: 'Câmera', icon: <Camera size={22} strokeWidth={1.5}/>, preview: ownCam }] : []),
          ]}
          shareFrom={panelMode === 'settings' ? null : panelMode === 'device' ? 'camera' : panelMode}
          onAdd={key => {
            setError(false)
            if (key === 'screen') {
              if (cfg.kind === 'device') update({ kind: pref.get('visor.screenKind', 'monitor'), sourceId: null })
              setPanelMode('screen')
            } else if (s.sharing) setPanelMode('camera')
            else { update({ kind: 'device' }); setPanelMode('device') }
            setPanelOpen(true)
          }}
          shareOpen={panelOpen}
          shareTitle={panelMode === 'settings' ? 'Ajustes' : panelMode === 'screen' ? 'Tela' : 'Câmera'}
          onShareClose={() => setPanelOpen(false)}
          onShareSettings={() => { setPanelMode('settings'); setPanelOpen(true) }}
          onStopShare={stopShare}
          onCamOff={() => update({ camId: null })}
          shareContent={panelMode === 'camera' ? <CameraSheet cfg={cfg} update={update} live={!!ownCam} /> : <>
            <SharePanel cfg={cfg} update={update} live={s.sharing} open={panelOpen} peers={s.peers} uplink={s.uplink} apps={apps}
              nativeCapture={nativeCapture} onStart={async () => { setError(false); if (await start()) setPanelOpen(false) }}/>
            {error && <span role="status" className="share-error">{error}</span>}
          </>}
          onPeek={card => { clearTimeout(hoverTimer.current); setHover(card ? { id: card.id, peer: card } : null) }}
          onPlace={id => {
            placedAt.current.set(id, Date.now())
            if (camOf(id)) { if (pipRef.current?.id === id) setPip(null); setCamOnTable(camOf(id), true); setHover(null); return }
            if (pipRef.current?.id === id) { setPip(null); setHover(null); return } // carta do miniplayer: volta para a mesa
            if (id === endpointId) setOwnOnTable(true)
            else roomRef.current.watch(id, false, allPeers.find(p => p.id === id))
            setHover(null)
          }}
          onReturn={id => {
            placedAt.current.delete(id)
            if (camOf(id)) setCamOnTable(camOf(id), false)
            else if (id === endpointId) setOwnOnTable(false)
            else roomRef.current.stopWatching(id)
          }}
          onPip={openPip}
          onPipDrag={miniDesktop ? pipDrag : undefined}
          ghost={ghost}
          apiRef={tableApi}
          renderStage={(tile, tools) => <Stage tools={tools} stream={tile.stream} cam={tile.cam} camOnly={!!tile.camOf} onCamOut={tile.cam ? () => setCamOnTable(tile.id, true) : undefined}
            local={tile.own} stats={tile.camOf ? null : tile.stats} room={roomRef.current} streamId={tile.id} replay={tile.own && !tile.camOf && replayOn}
            sendStats={s.sendStats} captureEngine={s.captureEngine} captureStats={s.captureStats}
            hasAudio={!tile.own && !tile.camOf && !!tile.stream?.getAudioTracks().length} watchingName={tile.name}/>}
        />

        {clipSaved && <div key={clipSaved.at} className="clip-toast" role="status"><Clapperboard size={15} strokeWidth={1.8}/>Clip salvo<span className="mono">{fmtClip(clipSaved.duration)}</span></div>}
        {pipTile && <MiniPlayer key={pip.id + (pip.win ? ':w' : ':f')} win={pip.win} stream={pipTile.stream} local={pipTile.id === endpointId}
          name={nameOf(pipTile.id)} mode={pip.mode} ratio={ratioOf(pip.id)} cardSize={cardSize()}
          onMode={mode => setPip(p => p && { ...p, mode })}
          onGhost={c => setGhost(c && { id: pip.id, x: c.x, y: c.y })}
          onDropInside={pipDropInside}
          onBack={() => setPip(null)}
          onClose={() => { if (camOf(pipTile.id)) setCamOnTable(camOf(pipTile.id), false); else if (pipTile.id === endpointId) setOwnOnTable(false); else roomRef.current.stopWatching(pipTile.id); setPip(null) }}/>}
        {chatChannel && (
          <IconButton
            label={chat ? 'Fechar chat da chamada' : 'Abrir chat da chamada'}
            className="chat-toggle"
            active={chat}
            onClick={() => {
              setChat((v) => !v)
              pref.set(chatKey, !chat)
            }}
          >
            <MessageSquare size={17} fill={chat ? 'currentColor' : 'none'}/>
            {!chat && unread > 0 && <span className="chat-unread">{unread > 9 ? '9+' : unread}</span>}
          </IconButton>
        )}
      </div>
      {chatChannel && (
        <div className="screen-chat" aria-hidden={!chat}>
          {chat && <TextChannel key={chatChannel.id} channel={chatChannel} profile={profile} compact />}
        </div>
      )}
    </div>
  )
}

// Ponto do video na tela (object-fit: contain): converte entre o clique e as coordenadas normalizadas do ping.
function videoFrame(video) {
  const box = video.getBoundingClientRect(), vw = video.videoWidth || 16, vh = video.videoHeight || 9
  const scale = Math.min(box.width / vw, box.height / vh), w = vw * scale, h = vh * scale
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, w, h, box }
}

const fmtClip = s => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0')

export function Stage({ tools, stream, cam, camOnly = false, onCamOut, local, stats, sendStats, captureEngine, captureStats, watchingName, hasAudio, room, streamId, replay }) {
  const [diag, setDiag] = useState(() => pref.get('visor.diag', false))
  const video = useRef(null)
  const box = useRef(null)
  const audioBooster = useRef(null)
  const [full, setFull] = useState(false)
  // Volume de 0 a 3.0 (0% a 300%, padrao 1.5 = 150%) com amplificador Web Audio + compressor
  const [volume, setVolume] = useState(() => pref.get('visor.volumeBoost', 1.5))
  const [muted, setMuted] = useState(false)
  const [blocked, setBlocked] = useState(false)
  // Pings recebidos nesta transmissao: onda + nome por 1,6 s no ponto apontado.
  const [pings, setPings] = useState([])
  const lastPing = useRef(0)
  useEffect(() => {
    if (!room || !streamId) return
    return room.onPing(p => {
      if (p.stream !== streamId || !video.current || !box.current) return
      const f = videoFrame(video.current)
      const ping = { ...p, key: Math.random().toString(36).slice(2), left: f.left - f.box.left + p.x * f.w, top: f.top - f.box.top + p.y * f.h }
      if (!p.mine) play('drop', { gain: .6 })
      setPings(list => [...list.slice(-5), ping])
      setTimeout(() => setPings(list => list.filter(x => x !== ping)), 1700)
    })
  }, [room, streamId])
  const aim = e => box.current?.classList.toggle('is-aiming', e.altKey && !!stream && !!room)
  const pingAt = e => {
    if (!e.altKey || e.button !== 0 || !stream || !room || !streamId || e.target.closest('.stage-hud')) return
    e.preventDefault()
    e.stopPropagation()
    const now = performance.now()
    if (now - lastPing.current < 450) return
    const f = videoFrame(video.current)
    const x = (e.clientX - f.left) / f.w, y = (e.clientY - f.top) / f.h
    if (x < 0 || x > 1 || y < 0 || y > 1) return
    lastPing.current = now
    room.ping(streamId, x, y)
  }

  // Conecta amplificador Web Audio (GainNode + DynamicsCompressorNode) na track de audio recebida
  useEffect(() => {
    if (local || !stream || !hasAudio || typeof AudioContext === 'undefined') return
    const [audioTrack] = stream.getAudioTracks()
    if (!audioTrack) return
    let ctx
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' })
      const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]))
      const gain = ctx.createGain()
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -1.0
      limiter.knee.value = 6
      limiter.ratio.value = 12
      limiter.attack.value = 0.002
      limiter.release.value = 0.12
      source.connect(gain)
      gain.connect(limiter)
      limiter.connect(ctx.destination)
      audioBooster.current = { ctx, gain }
    } catch {
      audioBooster.current = null
    }
    return () => {
      audioBooster.current = null
      ctx?.close().catch(() => {})
    }
  }, [stream, local, hasAudio])

  useEffect(() => {
    const v = video.current
    if (!v) return
    if (v.srcObject !== stream) v.srcObject = stream ?? null
    const booster = audioBooster.current
    const silence = local || muted || blocked || volume === 0
    if (booster) {
      // O elemento <video> fica mudo para nao duplicar; o som sai pelo AudioContext amplificado ate 300%
      v.muted = true
      const targetGain = silence ? 0 : volume
      booster.gain.gain.setTargetAtTime(targetGain, booster.ctx.currentTime, 0.015)
      if (!silence && booster.ctx.state === 'suspended') {
        booster.ctx.resume().catch(() => setBlocked(true))
      }
    } else {
      v.muted = silence
      v.volume = Math.max(0, Math.min(1, volume))
    }
    if (stream && local) {
      // A previa pode parar enquanto o jogo tem foco. As tracks seguem ativas no WebRTC.
      const preview = () => {
        if (!desktop || document.hasFocus()) v.play().catch(() => {})
        else v.pause()
      }
      preview()
      if (desktop) {
        window.addEventListener('focus', preview)
        window.addEventListener('blur', preview)
        return () => {
          window.removeEventListener('focus', preview)
          window.removeEventListener('blur', preview)
        }
      }
    } else if (stream && !muted) {
      v.play().catch(() => {
        v.muted = true
        setBlocked(true)
        v.play().catch(() => {})
      })
    }
  }, [stream, local, muted, volume, blocked, hasAudio])

  useEffect(() => watchFullscreen(box.current, video.current, setFull), [])

  // Celular: a tela nao apaga enquanto voce assiste a uma transmissao (Wake Lock; liberado ao esconder a aba).
  useEffect(() => {
    if (local || !stream || !navigator.wakeLock) return
    let lock = null, alive = true
    const take = () => {
      if (document.visibilityState !== 'visible' || lock) return
      navigator.wakeLock.request('screen').then(l => {
        if (!alive) return l.release()
        lock = l
        l.addEventListener('release', () => { if (lock === l) lock = null })
      }).catch(() => {})
    }
    take()
    document.addEventListener('visibilitychange', take)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', take)
      lock?.release().catch(() => {})
    }
  }, [stream, local])

  const toggleFull = () => (full ? exitFullscreen(video.current) : enterFullscreen(box.current, video.current))

  // Toque: um toque mostra/esconde os controles (somem sozinhos em 3,5 s); dois toques = tela cheia.
  const [hud, setHud] = useState(false)
  const hudTimer = useRef(0)
  const lastTap = useRef(null)
  const lastPointer = useRef('mouse')
  useEffect(() => () => clearTimeout(hudTimer.current), [])
  const showHud = (on) => {
    clearTimeout(hudTimer.current)
    setHud(on)
    if (on) hudTimer.current = setTimeout(() => setHud(false), 3500)
  }
  const tap = e => {
    lastPointer.current = e.pointerType
    if (e.pointerType === 'mouse' || !stream) return
    if (e.target.closest('.stage-hud, .diag')) return showHud(true)
    const now = performance.now(), prev = lastTap.current
    if (prev && now - prev.t < 320 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 40) {
      lastTap.current = null
      toggleFull()
      showHud(false)
      return
    }
    lastTap.current = { t: now, x: e.clientX, y: e.clientY }
    showHud(!hud)
  }
  const silent = muted || blocked || volume === 0
  const volPct = Math.round((muted ? 0 : volume) * 100)

  return (
    <div ref={box} className={`stage ${stream ? 'has-stream' : ''} ${camOnly ? 'is-cam' : ''} ${camOnly && local ? 'is-mirror' : ''} ${hud ? 'show-hud' : ''} ${full ? 'is-full' : ''}`}
      onDoubleClick={e => stream && !e.altKey && lastPointer.current === 'mouse' && toggleFull()}
      onPointerUp={tap} onPointerDown={pingAt} onPointerMove={aim} onPointerLeave={() => box.current?.classList.remove('is-aiming')}>
      <video ref={video} autoPlay={!local} playsInline muted />
      {stream && cam && <CamBubble stream={cam} local={local} onOut={onCamOut} />}
      {!!pings.length && <div className="stage-pings" aria-hidden>
        {pings.map(p => <span key={p.key} className={'stage-ping' + (p.mine ? ' is-mine' : '')} style={{ left: p.left, top: p.top }}>
          <i/><i/><b>{p.mine ? 'você' : p.name}</b></span>)}
      </div>}
      {!stream && (
        <div className="stage-idle" aria-hidden>
          <span className="pulse-ring" />
          <Monitor size={30} strokeWidth={1.25} />
        </div>
      )}
      {stream && diag && <Diagnostics local={local} stats={stats} sendStats={sendStats} captureEngine={captureEngine} captureStats={captureStats} />}
      {stream && (
        <div className={`stage-hud ${blocked ? 'is-pinned' : ''}`}>
          <span className="hud-chip">
            <span className={`live-dot ${local ? 'is-local' : ''}`} />
            {local && !camOnly ? 'voce' : watchingName}
          </span>
          {local && replay && <span className="hud-chip" data-tip="Replay ligado: F9 salva o clipe"><Clapperboard size={12} strokeWidth={1.9}/>F9</span>}
          {stats && !local && (
            <span className="hud-chip mono">
              {stats.height ? `${stats.height}p` : '–'} · {stats.decoded ?? '–'} · {stats.kbps == null ? '–' : fmtMbps(stats.kbps * 1000)}
            </span>
          )}
          <IconButton
            label="Diagnóstico"
            className="hud-btn"
            active={diag}
            aria-pressed={diag}
            magnetic={false}
            onClick={() => {
              setDiag(!diag)
              pref.set('visor.diag', !diag)
            }}
          >
            <Activity size={15} strokeWidth={1.75} />
          </IconButton>
          <span className="hud-spacer" />
          {hasAudio && (
            <span className="hud-volume">
              <IconButton
                label={silent ? 'Ativar som' : 'Mudo'}
                className={`hud-btn ${blocked ? 'is-attention' : ''}`}
                magnetic={false}
                onClick={() => {
                  audioBooster.current?.ctx?.resume().catch(() => {})
                  if (blocked) return setBlocked(false)
                  setMuted((m) => !m)
                }}
              >
                {silent ? <VolumeX size={15} strokeWidth={1.75} /> : <Volume2 size={15} strokeWidth={1.75} />}
              </IconButton>
              <input
                type="range"
                className="hud-range"
                min={0}
                max={3}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label="Volume"
                style={{ '--v': `${((muted ? 0 : volume) / 3) * 100}%` }}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  audioBooster.current?.ctx?.resume().catch(() => {})
                  setVolume(v)
                  setMuted(false)
                  setBlocked(false)
                  pref.set('visor.volumeBoost', v)
                }}
              />
              <span className="hud-vol-pct mono">{volPct}%</span>
            </span>
          )}
          <IconButton label={full ? 'Sair da tela cheia' : 'Tela cheia'} className="hud-btn" onClick={toggleFull} magnetic={false}>
            {full ? <Minimize size={15} strokeWidth={1.75} /> : <Maximize size={15} strokeWidth={1.75} />}
          </IconButton>
          {tools}
        </div>
      )}
    </div>
  )
}

// ---------- Diagnostico: onde os quadros se perdem ----------

function implementation(name, powerEfficient) {
  if (!name) return powerEfficient === true ? 'hardware' : null
  if (/libvpx|openh264|ffmpeg|dav1d|libaom/i.test(name)) return 'software'
  return name.match(/\(([^()]+)\)/)?.[1] ?? name
}
const ROUTE = { host: 'host', direta: 'direta', relay: 'TURN' }
const LIMIT = { cpu: 'cpu', bandwidth: 'banda', other: 'outro' }
const mbps = (kbps) => kbps == null ? null : (kbps / 1000).toFixed(1)
const pct = (value) => value == null ? null : `${value}%`
const ms = (value) => value == null ? null : `${value}ms`

function Cell({ k, v, bad }) {
  return (
    <span className={`dg-cell ${bad ? 'is-bad' : ''}`}>
      <span className="dg-k">{k}</span>
      <span className="dg-v">{v ?? '–'}</span>
    </span>
  )
}

function Diagnostics({ local, stats, sendStats, captureEngine, captureStats }) {
  if (local) {
    const v = sendStats?.viewers ?? []
    const captureDrops = (captureStats?.busy ?? 0) + (captureStats?.bridgeDrops ?? 0) + (captureStats?.writerDrops ?? 0)
    return (
      <div className="diag mono" role="group" aria-label="Diagnóstico da transmissão">
        <div className="dg-row">
          {captureEngine && <Cell k="motor" v={captureEngine === 'rust' ? 'Rust' : 'Chromium'} />}
          <Cell k="fps captura" v={sendStats?.capture} />
          {captureStats && (
            <>
              <Cell k="fps WGC" v={captureStats.source} />
              <Cell k="fps texturas" v={captureStats.shared} />
              <Cell k="descartes" v={captureDrops} bad={captureDrops > 0} />
            </>
          )}
        </div>
        {v.map((x) => (
          <div className="dg-row" key={x.id}>
            <span className="dg-name">{x.name}</span>
            <Cell k="fps codif." v={x.encoded} />
            <Cell k="fps envio" v={x.fps} />
            <Cell k="codec" v={x.codec} />
            <Cell k="encoder" v={implementation(x.encoder, x.powerEfficient)} />
            <Cell k="ms/q" v={x.encodeMs} />
            <Cell k="mbps" v={mbps(x.kbps)} />
            <Cell k="fila RTP" v={ms(x.sendQueueMs)} />
            <Cell k="res" v={x.height ? `${x.height}p` : null} />
            <Cell k="rtt" v={ms(x.rtt)} />
            <Cell k="perda" v={pct(x.loss)} bad={x.loss > 1} />
            <Cell k="rota" v={ROUTE[x.route]} />
            {LIMIT[x.limit] && <Cell k="limite" v={LIMIT[x.limit]} bad />}
          </div>
        ))}
      </div>
    )
  }
  if (!stats) return null
  return (
    <div className="diag mono" role="group" aria-label="Diagnóstico da reprodução">
      <div className="dg-row">
        <Cell k="fps receb." v={stats.fps} />
        <Cell k="fps decod." v={stats.decoded} />
        <Cell k="descart" v={stats.dropped} bad={stats.dropped > 0} />
        <Cell k="travou" v={stats.freezes} bad={stats.freezeDelta > 0} />

      </div>
      {stats.lastFreeze && <div className="dg-row">
        <span className="dg-name">Pausa {new Date(stats.lastFreeze.at).toLocaleTimeString()}</span>
        <Cell k="ms no intervalo" v={ms(stats.lastFreeze.duration)} bad />
        <Cell k="perda" v={pct(stats.lastFreeze.loss)}/>
        <Cell k="jitter" v={ms(stats.lastFreeze.jitter)}/>
        <Cell k="buffer" v={ms(stats.lastFreeze.bufferMs)}/>
        <Cell k="ms/q" v={stats.lastFreeze.decodeMs}/>
      </div>}
      <div className="dg-row">
        <Cell k="res" v={stats.height ? `${stats.width}x${stats.height}` : null} />
        <Cell k="mbps" v={mbps(stats.kbps)} />
        <Cell k="codec" v={stats.codec} />
        <Cell k="decoder" v={implementation(stats.decoder, stats.powerEfficient)} />
        <Cell k="ms/q" v={stats.decodeMs} />
      </div>
      <div className="dg-row">
        <Cell k="perda" v={pct(stats.loss)} bad={stats.loss > 1} />
        <Cell k="jitter" v={ms(stats.jitter)} />
        <Cell k="buffer" v={ms(stats.bufferMs)} />
        <Cell k="rtt" v={ms(stats.rtt)} />
        <Cell k="rota" v={ROUTE[stats.route]} />
      </div>
    </div>
  )
}

// Ilha que se expande do botao de transmitir (conceito "Morph island")

// Camera de quem transmite sobre a tela. Fica num canto (o mesmo para todas as transmissoes, salvo em
// visor.camCorner); arrastar leva ao canto mais proximo; o botao recolhe numa pilula e devolve. Some em telas
// muito pequenas (carta pequena na mesa) por container query.
const CORNERS = ['tl', 'tr', 'bl', 'br']
function CamBubble({ stream, local, onOut }) {
  const video = useRef(null)
  const el = useRef(null)
  const [corner, setCorner] = useState(() => CORNERS.includes(pref.get('visor.camCorner', 'br')) ? pref.get('visor.camCorner', 'br') : 'br')
  const [hidden, setHidden] = useState(false)
  const [drag, setDrag] = useState(null)
  const [live, setLive] = useState(false)
  useEffect(() => {
    const v = video.current
    if (!v) return
    if (v.srcObject !== stream) v.srcObject = stream
    v.play?.().catch(() => {})
    const [t] = stream.getVideoTracks()
    // So aparece com quadros chegando (a trilha existe desde o inicio, vazia enquanto a camera esta desligada).
    const sync = () => setLive(!!t && !t.muted && t.readyState === 'live')
    const ready = () => setLive(true)
    sync()
    t?.addEventListener('mute', sync)
    t?.addEventListener('unmute', sync)
    t?.addEventListener('ended', sync)
    v.addEventListener('loadeddata', ready)
    return () => {
      t?.removeEventListener('mute', sync)
      t?.removeEventListener('unmute', sync)
      t?.removeEventListener('ended', sync)
      v.removeEventListener('loadeddata', ready)
    }
  }, [stream])
  const dragRef = useRef(null) // estado do arraste lido nos eventos (o setState so redesenha)
  const down = (e) => {
    e.stopPropagation() // nao levanta a carta da mesa nem conta como toque no palco
    if (e.button !== 0 || e.target.closest('button')) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ponteiro ja solto */ }
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0 }
    setDrag(dragRef.current)
  }
  const move = (e) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.id) return
    e.stopPropagation()
    dragRef.current = { ...d, dx: e.clientX - d.x, dy: e.clientY - d.y }
    setDrag(dragRef.current)
  }
  const up = (e) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.id) return
    e.stopPropagation()
    dragRef.current = null
    const box = el.current?.parentElement?.getBoundingClientRect()
    const me = el.current?.getBoundingClientRect()
    if (box && me && Math.hypot(d.dx, d.dy) > 6) {
      // o retangulo medido ja inclui o deslocamento do arraste (translate)
      const cx = me.left + me.width / 2, cy = me.top + me.height / 2
      const next = (cy < box.top + box.height / 2 ? 't' : 'b') + (cx < box.left + box.width / 2 ? 'l' : 'r')
      setCorner(next)
      pref.set('visor.camCorner', next)
    }
    setDrag(null)
  }
  return (
    <div ref={el} className={`cam-bubble at-${corner} ${hidden ? 'is-hidden' : ''} ${live ? 'is-live' : ''} ${drag ? 'is-dragging' : ''} ${local ? 'is-local' : ''}`}
      style={drag ? { translate: `${drag.dx}px ${drag.dy}px` } : undefined}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={e => e.stopPropagation()}>
      <video ref={video} autoPlay playsInline muted />
      {onOut && !hidden && <button type="button" className="cam-toggle cam-out" aria-label="Câmera na mesa" data-tip="Na mesa"
        onClick={e => { e.stopPropagation(); onOut() }}><SquareArrowOutUpRight size={12} strokeWidth={2} /></button>}
      <button type="button" className="cam-toggle" aria-label={hidden ? 'Mostrar câmera' : 'Esconder câmera'} data-tip={hidden ? 'Mostrar câmera' : 'Esconder câmera'}
        onClick={e => { e.stopPropagation(); setHidden(!hidden) }}>
        {hidden ? <Camera size={13} strokeWidth={1.9} /> : <Minus size={13} strokeWidth={2} />}
      </button>
    </div>
  )
}

// Carta Camera aberta durante a transmissao: escolher a camera (ou desligar) sem mexer na tela.
function CameraSheet({ cfg, update, live }) {
  const all = useCameras()
  const cams = (all ?? []).filter(c => !(cfg.kind === 'device' && c.id === cfg.deviceId))
  const pick = id => update({ camId: id })
  if (all && !cams.length) return <div className="cam-sheet is-empty"><CameraOff size={22} strokeWidth={1.4} /><span>Nenhuma câmera</span></div>
  return (
    <ul className="dd-list cam-sheet" role="radiogroup" aria-label="Câmera">
      {!all && <li className="sp-loading"><span className="spin-icon" /></li>}
      {cams.map((c, i) => {
        const on = cfg.camId === c.id
        return <li key={c.id}>
          <button type="button" role="radio" aria-checked={on} className={`dd-row ${on ? 'is-on' : ''}`} onClick={() => pick(c.id)}>
            <span className="dd-check is-radio">{on && <Check size={11} strokeWidth={2.5} />}</span>
            <Camera size={14} strokeWidth={1.75} className="dd-icon" />
            <span className="dd-name">{c.label || `Câmera ${i + 1}`}</span>
            {on && live && <span className="live-dot" />}
          </button>
        </li>
      })}
      {cams.length > 0 && <li>
        <button type="button" role="radio" aria-checked={!cfg.camId} className={`dd-row ${!cfg.camId ? 'is-on' : ''}`} onClick={() => pick(null)}>
          <span className="dd-check is-radio">{!cfg.camId && <Check size={11} strokeWidth={2.5} />}</span>
          <CameraOff size={14} strokeWidth={1.75} className="dd-icon" />
          <span className="dd-name">Desligada</span>
        </button>
      </li>}
    </ul>
  )
}
