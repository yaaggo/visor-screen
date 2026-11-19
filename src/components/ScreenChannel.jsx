import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, ChevronRight, Eye, Maximize, MessageSquare, Minimize, Monitor, MonitorUp, Smartphone, Square, Volume2, VolumeX, X } from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { deviceKind, endpointId } from '../lib/presence.js'
import { ScreenRoom } from '../lib/screen.js'
import { fmtMbps, getPreset } from '../lib/quality.js'
import { desktop } from '../lib/env.js'
import { captureDesktop, captureDevice, captureWeb } from '../lib/sources.js'
import { Avatar, IconButton } from './ui.jsx'
import SharePanel, { exeKey, pref, useShareConfig } from './SharePanel.jsx'
import StreamGrid from './StreamGrid.jsx'
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

export default function ScreenChannel({ channel, profile, chatChannel, visitors = [], photo, reportMember, visible = true, onConnection }) {
  const roomRef = useRef(null)
  const captureRef = useRef(null)
  const starting = useRef(false)
  const [s, setS] = useState({ peers: [], sharing: false, local: null, remote: null, watching: null, viewers: 0, preset: '1080p60', bitrate: 0, uplink: null, stats: null, remoteAudio: false })
  const [peopleOpen, setPeopleOpen] = useState(true)
  useEffect(() => { onConnection?.(Boolean(s.connected)) }, [s.connected, onConnection])
  useEffect(() => {
    if (!visible) { setHover(null); setMenu(null) }
  }, [visible])
  const [hover, setHover] = useState(null)
  const hoverTimer = useRef(null)
  const [menu, setMenu] = useState(null)
  const [chat, setChat] = useState(() => pref.get('visor.chatOpen', true))
  const [cfg, update] = useShareConfig()
  const [error, setError] = useState(false)
  const [nativeCapture, setNativeCapture] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
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
  const tiles = inputs.filter(input => !input.preview)
  if (s.sharing) tiles.unshift({ id: endpointId, stream: s.local })
  const toggle = (id, peerHint = null) => {
    const room = roomRef.current
    if (room.inputs.has(id) && !room.inputs.get(id).preview) room.stopWatching(id)
    else room.watch(id, false, peerHint)
    setHover(null)
    setMenu(null)
  }
  const person = (p, compact) => {
    const own = p.id === endpointId
    const active = tiles.some(tile => tile.id === p.id)
    return <button key={p.id} className={'participant' + (p.sharing ? ' live' : '')} aria-label={p.name} title={p.name}
      aria-pressed={p.sharing ? active : undefined}
      onMouseEnter={e => {
        clearTimeout(hoverTimer.current)
        if (!p.sharing || active) return
        const rect = e.currentTarget.getBoundingClientRect()
        setHover({id:p.id, peer:p, left:Math.min(innerWidth-212, Math.max(8,rect.left)), top:Math.max(8,rect.top-126)})
      }} onMouseLeave={hidePreview}
      onClick={() => { if (p.sharing && !own) { if (!active) toggle(p.id, p); else setHover(null) } }}
      onContextMenu={e => {
        if (!p.sharing || own) return
        e.preventDefault()
        setHover(null)
        setMenu({ id:p.id, peer:p, x:Math.min(innerWidth-160,e.clientX), y:Math.min(innerHeight-48,e.clientY) })
      }}>
      <span className="participant-face"><Avatar id={p.profileId ?? p.id} revision={own ? photo : p.photo} name={p.name} size={compact ? 52 : 60}/>
        <span className="person-device">{(own ? deviceKind : p.device) === 'mobile' ? <Smartphone size={9} aria-label="Celular"/> : <Monitor size={9} aria-label="Computador"/>}</span>
        {p.sharing && <i className="live-dot"/>}</span>
      <span className="participant-meta"><span>{p.name}</span>{(own ? deviceKind : p.device) === 'mobile' ? <Smartphone size={11} className="device-icon" aria-label="Celular"/> : <Monitor size={11} className="device-icon" aria-label="Computador"/>}</span>{compact && !!p.watching?.length && <Eye size={12} aria-label="Assistindo"/>}
    </button>
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

  const hoverPeer = allPeers.find(p => p.id === hover?.id && p.sharing)
  const preview = hoverPeer && (hoverPeer.id === endpointId ? s.local : inputs.find(v => v.id === hoverPeer.id)?.stream)

  return (
    <div className={`screen ${chat && chatChannel ? 'with-chat' : ''}`}>
      {hoverPeer && createPortal(<button className="stream-hover" onMouseEnter={() => clearTimeout(hoverTimer.current)} onMouseLeave={hidePreview} onClick={() => { if (hoverPeer.id !== endpointId) roomRef.current.watch(hoverPeer.id, false, hoverPeer); setHover(null) }} style={{left:hover.left, top:hover.top}}>
        <video autoPlay muted playsInline ref={node => { if (node && node.srcObject !== preview) node.srcObject = preview ?? null }}/>
        <small>{hoverPeer.name}</small>
      </button>, document.body)}
      {menu && createPortal(<button autoFocus className="stream-menu" style={{left:menu.x,top:menu.y}} onPointerDown={e => e.stopPropagation()}
        onClick={() => toggle(menu.id, menu.peer)}>{tiles.some(v => v.id === menu.id) ? 'Parar de assistir' : 'Assistir'}</button>,document.body)}
      <div className="stage-wrap">
        {tiles.length ? <StreamGrid count={tiles.length}>
          {tiles.map(tile => <Stage key={tile.id} stream={tile.stream} local={tile.id === endpointId} stats={tile.stats}
            sendStats={s.sendStats} captureEngine={s.captureEngine} captureStats={s.captureStats}
            hasAudio={tile.id !== endpointId && !!tile.stream?.getAudioTracks().length}
            watchingName={allPeers.find(p => p.id === tile.id)?.name}/>)}
        </StreamGrid> : <div className="idle-frame" aria-label="Sem transmissão" />}

        <aside className={'people-drawer' + (peopleOpen ? ' is-open' : '')} aria-label="Participantes">
          <button className="people-toggle" aria-label={peopleOpen ? 'Ocultar participantes' : 'Mostrar participantes'}
            aria-expanded={peopleOpen} onClick={() => setPeopleOpen(!peopleOpen)}><ChevronRight size={15}/></button>
          <div className="people-track" inert={!peopleOpen}>{allPeers.map(p => person(p,true))}</div>
        </aside>
        <Island
          s={s}
          cfg={cfg}
          apps={apps}
          onOpenChange={setPanelOpen}
          update={update}
          error={error}
          nativeCapture={nativeCapture}
          onStart={() => {
            setError(false)
            return start()
          }}
          onStop={() => {
            roomRef.current.stopShare()
            captureRef.current = null
          }}
        />

        {chatChannel && (
          <IconButton
            label={chat ? 'Fechar chat da chamada' : 'Abrir chat da chamada'}
            className="chat-toggle"
            active={chat}
            onClick={() => {
              setChat((v) => !v)
              pref.set('visor.chatOpen', !chat)
            }}
          >
            <MessageSquare size={17} fill={chat ? 'currentColor' : 'none'}/>
          </IconButton>
        )}
      </div>
      {chatChannel && (
        <div className="screen-chat" aria-hidden={!chat}>
          {chat && <TextChannel channel={chatChannel} profile={profile} compact />}
        </div>
      )}
    </div>
  )
}

function Stage({ stream, local, stats, sendStats, captureEngine, captureStats, watchingName, hasAudio }) {
  const [diag, setDiag] = useState(() => pref.get('visor.diag', false))
  const video = useRef(null)
  const box = useRef(null)
  const audioBooster = useRef(null)
  const [full, setFull] = useState(false)
  // Volume de 0 a 3.0 (0% a 300%, padrao 1.5 = 150%) com amplificador Web Audio + compressor
  const [volume, setVolume] = useState(() => pref.get('visor.volumeBoost', 1.5))
  const [muted, setMuted] = useState(false)
  const [blocked, setBlocked] = useState(false)

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

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : box.current.requestFullscreen())
  const silent = muted || blocked || volume === 0
  const volPct = Math.round((muted ? 0 : volume) * 100)

  return (
    <div ref={box} className={`stage ${stream ? 'has-stream' : ''}`} onDoubleClick={() => stream && toggleFull()}>
      <video ref={video} autoPlay={!local} playsInline muted />
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
            {local ? 'voce' : watchingName}
          </span>
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
function Island({ s, cfg, apps, onOpenChange, update, error, nativeCapture, onStart, onStop }) {
  const [open, setOpen] = useState(false)
  useEffect(() => onOpenChange(open), [open, onOpenChange])
  const ref = useRef(null)
  const preset = getPreset(s.sharing ? s.preset : cfg.presetId)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false)
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    addEventListener('pointerdown', onDown)
    addEventListener('keydown', onKey)
    return () => {
      removeEventListener('pointerdown', onDown)
      removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className={`island ${open ? 'is-open' : ''} ${s.sharing ? 'is-live' : ''} ${error ? 'shake' : ''}`}>
      <div className="island-bar">
        {s.sharing ? (
          <>
            <span className="island-live">
              <span className="live-dot" />
              <span className="mono">
                {preset.res}·{preset.fps}·{fmtMbps(s.bitrate)}
              </span>
            </span>
            <span className="island-count" data-tip="Assistindo">
              <Eye size={14} strokeWidth={1.75} />
              <span className="mono">{s.viewers}</span>
            </span>
            <IconButton label="Ajustes" active={open} onClick={() => setOpen((v) => !v)} magnetic={false}>
              <MonitorUp size={16} strokeWidth={1.75} />
            </IconButton>
            <button type="button" className="stop-btn" aria-label="Parar" data-tip="Parar" onClick={onStop}>
              <Square size={12} fill="currentColor" />
            </button>
          </>
        ) : (
          <>
            <span className="island-count" data-tip="Na sala">
              <Eye size={14} strokeWidth={1.75} />
              <span className="mono">{s.peers.length}</span>
            </span>
            <button type="button" className="share-btn" aria-label="Transmitir" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              <MonitorUp size={17} strokeWidth={1.75} />
            </button>
          </>
        )}
      </div>

      <div className="island-panel" inert={!open}>
        <div className="island-panel-inner">
          <SharePanel
            cfg={cfg}
            update={update}
            live={s.sharing}
            open={open}
            peers={s.peers}
            uplink={s.uplink}
            apps={apps}
            nativeCapture={nativeCapture}
            onStart={async () => {
              if (await onStart()) setOpen(false)
            }}
          />
          {error && <span role="status" className="share-error">{error}</span>}
        </div>
      </div>
    </div>
  )
}
