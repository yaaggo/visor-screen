import { useEffect, useRef, useState } from 'react'
import { Eye, Maximize, MessageSquare, Minimize, Monitor, MonitorUp, Square, Volume2, VolumeX, X } from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { ScreenRoom } from '../lib/screen.js'
import { fmtMbps, getPreset } from '../lib/quality.js'
import { desktop } from '../lib/env.js'
import { captureDesktop, captureDevice, captureWeb } from '../lib/sources.js'
import { Avatar, IconButton } from './ui.jsx'
import SharePanel, { pref, useShareConfig } from './SharePanel.jsx'
import TextChannel from './TextChannel.jsx'

let selfPid = 0
if (desktop) window.visor.selfPid().then((p) => (selfPid = p))

// Converte a selecao de audio em alvos do helper nativo
const audioTargets = (audio) =>
  (Array.isArray(audio) ? audio : []).map((a) => (a === 'system' ? { pid: selfPid, exclude: true } : { pid: a, exclude: false }))

export default function ScreenChannel({ channel, profile, chatChannel }) {
  const roomRef = useRef(null)
  const captureRef = useRef(null)
  const [s, setS] = useState({ peers: [], sharing: false, local: null, remote: null, watching: null, viewers: 0, preset: '1080p60', bitrate: 0, uplink: null, stats: null, remoteAudio: false })
  const [chat, setChat] = useState(() => pref.get('visor.chatOpen', true))
  const [cfg, update] = useShareConfig()
  const [error, setError] = useState(false)

  useEffect(() => {
    const room = new ScreenRoom({ supabase, roomId: channel.id, me: { id: profile.id, name: profile.username }, onChange: setS })
    roomRef.current = room
    if (import.meta.env.DEV) window.__room = room // depuracao: window.__room.out / .inPc
    room.join()
    return () => room.leave()
  }, [channel.id, profile.id, profile.username])

  // Ao vivo: aplica mudancas de qualidade, bitrate e audio sem reiniciar
  useEffect(() => {
    if (s.sharing) roomRef.current.setPreset(cfg.presetId)
  }, [cfg.presetId, s.sharing])
  useEffect(() => {
    if (s.sharing) roomRef.current.setBitrate(cfg.bitrate)
  }, [cfg.bitrate, s.sharing])
  useEffect(() => {
    if (s.sharing) captureRef.current?.mixer?.set(audioTargets(cfg.audio))
  }, [cfg.audio, s.sharing])

  const start = async () => {
    const preset = getPreset(cfg.presetId)
    try {
      let cap
      if (cfg.kind === 'device') {
        if (!cfg.deviceId) throw new Error('device')
        cap = await captureDevice(cfg.deviceId, preset, cfg.deviceAudioId)
      } else if (desktop) {
        if (!cfg.sourceId) throw new Error('source')
        cap = await captureDesktop(cfg.sourceId, preset, audioTargets(cfg.audio))
      } else {
        cap = await captureWeb(cfg.kind, preset, cfg.audio === true)
      }
      captureRef.current = cap
      await roomRef.current.startShare(cap, cfg.presetId, cfg.bitrate)
      roomRef.current.stopWatching()
      return true
    } catch (err) {
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        setError(true)
        setTimeout(() => setError(false), 500)
      }
      return false
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

function Stage({ stream, local, stats, watchingName, hasAudio }) {
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
    if (stream && !local && !muted) {
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
      <video ref={video} autoPlay playsInline muted />
      {!stream && (
        <div className="stage-idle" aria-hidden>
          <span className="pulse-ring" />
          <Monitor size={30} strokeWidth={1.25} />
        </div>
      )}
      {stream && (
        <div className={`stage-hud ${blocked ? 'is-pinned' : ''}`}>
          <span className="hud-chip">
            <span className={`live-dot ${local ? 'is-local' : ''}`} />
            {local ? 'voce' : watchingName}
          </span>
          {stats && !local && (
            <span className="hud-chip mono">
              {stats.height || '-'}p · {stats.fps} · {fmtMbps(stats.kbps * 1000)}
            </span>
          )}
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

// Ilha que se expande do botao de transmitir (conceito "Morph island")
function Island({ s, cfg, update, error, onStart, onStop }) {
  const [open, setOpen] = useState(false)
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
            onStart={async () => {
              if (await onStart()) setOpen(false)
            }}
          />
        </div>
      </div>
    </div>
  )
}
