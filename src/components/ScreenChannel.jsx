import { useEffect, useRef, useState } from 'react'
import { Activity, Eye, Maximize, MessageSquare, Minimize, Monitor, MonitorUp, Square, Volume2, VolumeX, X } from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { ScreenRoom } from '../lib/screen.js'
import { fmtMbps, getPreset } from '../lib/quality.js'
import { desktop } from '../lib/env.js'
import { captureDesktop, captureDevice, captureWeb } from '../lib/sources.js'
import { Avatar, IconButton } from './ui.jsx'
import SharePanel, { exeKey, pref, useShareConfig } from './SharePanel.jsx'
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

export default function ScreenChannel({ channel, profile, chatChannel }) {
  const roomRef = useRef(null)
  const captureRef = useRef(null)
  const starting = useRef(false)
  const [s, setS] = useState({ peers: [], sharing: false, local: null, remote: null, watching: null, viewers: 0, preset: '1080p60', bitrate: 0, uplink: null, stats: null, remoteAudio: false })
  const [chat, setChat] = useState(() => pref.get('visor.chatOpen', true))
  const [cfg, update] = useShareConfig()
  const [error, setError] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const needsAudioApps = cfg.kind !== 'device' && (panelOpen || (s.sharing && cfg.audioMode === 'all' && cfg.exclude.length > 0))
  const apps = useAudioApps(needsAudioApps)
  const targetKey = JSON.stringify(audioTargets(cfg, apps))

  useEffect(() => {
    const room = new ScreenRoom({ supabase, roomId: channel.id, me: { id: profile.id, name: profile.username }, onChange: setS })
    roomRef.current = room
    if (import.meta.env.DEV) window.__room = room // depuracao: window.__room.out / .inPc
    room.join()
    return () => room.leave()
  }, [channel.id, profile.id, profile.username])

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

  const start = async () => {
    if (starting.current) return false
    starting.current = true
    const room = roomRef.current
    const preset = getPreset(cfg.presetId)
    try {
      let cap
      if (cfg.kind === 'device') {
        if (!cfg.deviceId) throw new Error('device')
        cap = await captureDevice(cfg.deviceId, preset, cfg.deviceAudioId)
      } else if (desktop) {
        if (!cfg.sourceId) throw new Error('source')
        cap = await captureDesktop(cfg.sourceId, preset, audioTargets(cfg, apps))
      } else {
        cap = await captureWeb(cfg.kind, preset, cfg.audioMode === 'all')
      }
      if (!(await room.startShare(cap, cfg.presetId, cfg.bitrate))) return false
      captureRef.current = cap
      room.stopWatching()
      return true
    } catch (err) {
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        setError(true)
        setTimeout(() => setError(false), 500)
      }
      return false
    } finally {
      starting.current = false
    }
  }

  const stream = s.sharing && !s.watching ? s.local : s.remote
  const sharers = s.peers.filter((p) => p.sharing)

  return (
    <div className={`screen ${chat && chatChannel ? 'with-chat' : ''}`}>
      <div className="stage-wrap">
        <Stage
          stream={stream}
          local={stream === s.local}
          stats={s.stats}
          sendStats={s.sendStats}
          hasAudio={stream !== s.local && s.remoteAudio}
          watchingName={s.peers.find((p) => p.id === s.watching)?.name}
        />

        {sharers.length > 0 && (
          <div className="sharers">
            {sharers.map((p) => {
              const mine = p.id === profile.id
              const on = mine ? s.sharing && !s.watching : s.watching === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`sharer ${on ? 'is-on' : ''}`}
                  data-tip={p.name}
                  aria-label={p.name}
                  onClick={() => (mine ? roomRef.current.stopWatching() : roomRef.current.watch(p.id))}
                >
                  <Avatar name={p.name} size={26} />
                  <span className="sharer-q">{getPreset(p.preset).res}</span>
                </button>
              )
            })}
          </div>
        )}

        <Island
          s={s}
          cfg={cfg}
          apps={apps}
          onOpenChange={setPanelOpen}
          update={update}
          error={error}
          onStart={start}
          onStop={() => {
            roomRef.current.stopShare()
            captureRef.current = null
          }}
        />

        {chatChannel && (
          <IconButton
            label={chat ? 'Fechar chat' : 'Chat'}
            className="chat-toggle"
            active={chat}
            onClick={() => {
              setChat((v) => !v)
              pref.set('visor.chatOpen', !chat)
            }}
          >
            {chat ? <X size={16} strokeWidth={1.75} /> : <MessageSquare size={16} strokeWidth={1.75} />}
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

function Stage({ stream, local, stats, sendStats, watchingName, hasAudio }) {
  const [diag, setDiag] = useState(() => pref.get('visor.diag', false))
  const video = useRef(null)
  const box = useRef(null)
  const [full, setFull] = useState(false)
  const [volume, setVolume] = useState(() => pref.get('visor.volume', 0.8))
  const [muted, setMuted] = useState(false)
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    const v = video.current
    if (!v) return
    if (v.srcObject !== stream) v.srcObject = stream ?? null
    v.muted = local || muted || blocked
    v.volume = volume
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
      v.muted = false
      v.play().catch(() => {
        // autoplay com som bloqueado: toca mudo e pede um clique
        v.muted = true
        setBlocked(true)
        v.play().catch(() => {})
      })
    }
  }, [stream, local, muted, volume, blocked])

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : box.current.requestFullscreen())
  const silent = muted || blocked || volume === 0

  return (
    <div ref={box} className={`stage ${stream ? 'has-stream' : ''}`} onDoubleClick={() => stream && toggleFull()}>
      <video ref={video} autoPlay={!local} playsInline muted />
      {!stream && (
        <div className="stage-idle" aria-hidden>
          <span className="pulse-ring" />
          <Monitor size={30} strokeWidth={1.25} />
        </div>
      )}
      {stream && diag && <Diagnostics local={local} stats={stats} sendStats={sendStats} />}
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
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                aria-label="Volume"
                style={{ '--v': `${(muted ? 0 : volume) * 100}%` }}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setVolume(v)
                  setMuted(false)
                  setBlocked(false)
                  pref.set('visor.volume', v)
                }}
              />
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

function Diagnostics({ local, stats, sendStats }) {
  if (local) {
    const v = sendStats?.viewers ?? []
    return (
      <div className="diag mono" role="group" aria-label="Diagnóstico da transmissão">
        <div className="dg-row">
          <Cell k="fps captura" v={sendStats?.capture} />
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
        <Cell k="travou" v={stats.freezes} bad={stats.freezes > 0} />
      </div>
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
function Island({ s, cfg, apps, onOpenChange, update, error, onStart, onStop }) {
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
            onStart={async () => {
              if (await onStart()) setOpen(false)
            }}
          />
        </div>
      </div>
    </div>
  )
}
