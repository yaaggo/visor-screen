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
import CardTable from './CardTable.jsx'
import { play } from '../lib/sound.js'
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

export default function ScreenChannel({ channel, profile, chatChannel, visitors = [], photo, reportMember, visible = true, onConnection, onUnread }) {
  const roomRef = useRef(null)
  const captureRef = useRef(null)
  const starting = useRef(false)
  const [s, setS] = useState({ peers: [], sharing: false, local: null, remote: null, watching: null, viewers: 0, preset: '1080p60', bitrate: 0, uplink: null, stats: null, remoteAudio: false })
  useEffect(() => { onConnection?.(Boolean(s.connected)) }, [s.connected, onConnection])
  useEffect(() => {
    if (!visible) { setHover(null); setMenu(null) }
  }, [visible])
  const [hover, setHover] = useState(null)
  const hoverTimer = useRef(null)
  const [menu, setMenu] = useState(null)
  const [chat, setChat] = useState(() => pref.get('visor.chatOpen', true))
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
  const stopShare = () => { roomRef.current.stopShare(); captureRef.current = null; play('stop') }
  const [ownOnTable, setOwnOnTable] = useState(true)
  const placedAt = useRef(new Map())
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
  const tiles = inputs.filter(input => !input.preview)
  if (s.sharing && ownOnTable) tiles.unshift({ id: endpointId, stream: s.local })
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


  return (
    <div className={`screen ${chat && chatChannel ? 'with-chat' : ''}`}>
      <div className="stage-wrap with-table">
        <CardTable
          tiles={tiles.map(tile => {
            const peer = allPeers.find(p => p.id === tile.id)
            if (!placedAt.current.has(tile.id)) placedAt.current.set(tile.id, Date.now())
            return { ...tile, own: tile.id === endpointId, name: tile.id === endpointId ? 'você' : peer?.name ?? '', since: placedAt.current.get(tile.id) }
          })}
          hand={[
            ...(s.sharing && !ownOnTable ? [{ id: endpointId, own: true, name: profile.username, profileId: profile.id, photo, device: deviceKind }] : []),
            ...allPeers.filter(p => p.sharing && p.id !== endpointId && !tiles.some(t => t.id === p.id)).map(p => ({
              ...p, peek: hover?.id === p.id ? inputs.find(v => v.id === p.id)?.stream ?? null : null,
            })),
          ]}
          visible={visible}
          audience={allPeers.filter(p => !p.sharing)}
          toasts={toasts}
          onToast={() => { setChat(true); pref.set('visor.chatOpen', true) }}
          showAdd={!s.sharing}
          onAdd={() => { setError(false); setPanelOpen(true) }}
          shareOpen={panelOpen}
          shareTitle={s.sharing ? 'Ajustes' : 'Transmitir'}
          onShareClose={() => setPanelOpen(false)}
          onShareSettings={() => setPanelOpen(true)}
          onStopShare={stopShare}
          shareContent={<>
            <SharePanel cfg={cfg} update={update} live={s.sharing} open={panelOpen} peers={s.peers} uplink={s.uplink} apps={apps}
              nativeCapture={nativeCapture} onStart={async () => { setError(false); if (await start()) setPanelOpen(false) }}/>
            {error && <span role="status" className="share-error">{error}</span>}
          </>}
          onPeek={card => { clearTimeout(hoverTimer.current); setHover(card ? { id: card.id, peer: card } : null) }}
          onPlace={id => {
            placedAt.current.set(id, Date.now())
            if (id === endpointId) setOwnOnTable(true)
            else roomRef.current.watch(id, false, allPeers.find(p => p.id === id))
            setHover(null)
          }}
          onReturn={id => {
            placedAt.current.delete(id)
            if (id === endpointId) setOwnOnTable(false)
            else roomRef.current.stopWatching(id)
          }}
          renderStage={(tile, tools) => <Stage tools={tools} stream={tile.stream} local={tile.own} stats={tile.stats}
            sendStats={s.sendStats} captureEngine={s.captureEngine} captureStats={s.captureStats}
            hasAudio={!tile.own && !!tile.stream?.getAudioTracks().length} watchingName={tile.name}/>}
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
            {!chat && unread > 0 && <span className="chat-unread">{unread > 9 ? '9+' : unread}</span>}
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

export function Stage({ tools, stream, local, stats, sendStats, captureEngine, captureStats, watchingName, hasAudio }) {
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
