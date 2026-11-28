import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpToLine, AppWindow, AudioLines, Check, FlipVertical2, VideoOff, ChevronDown, Clapperboard, Cpu, Gauge, LoaderCircle, Monitor, RefreshCw, Speaker, Video, VolumeX } from 'lucide-react'
import { BITRATES, PRESETS, fmtMbps, getPreset, snapBitrate } from '../lib/quality.js'
import { desktop } from '../lib/env.js'
import { listDevices, matchAudio } from '../lib/sources.js'
import { measureUpload } from '../lib/net.js'
import { replaySupported } from '../lib/replay.js'
import { IconButton, Segmented } from './ui.jsx'

export const pref = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k)
      return v === null ? d : JSON.parse(v)
    } catch {
      return d
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {
      /* ignore */
    }
  },
}

export const exeKey = (exe) => exe.toLowerCase()

// Celular (Android e iPhone) nao tem captura de tela no navegador: so a camera/placa como fonte.
export const screenCaptureSupported = () => desktop || !!navigator.mediaDevices?.getDisplayMedia
const DEFAULT_PRESET = () => (screenCaptureSupported() ? '1080p60' : '720p30')

// Estado de configuracao da transmissao (persistido por usuario no navegador/app)
export function useShareConfig() {
  const [cfg, setCfg] = useState(() => ({
    kind: screenCaptureSupported() ? pref.get('visor.kind', 'monitor') : 'device', // monitor | window | device
    sourceId: null,
    engine: pref.get('visor.captureEngineStable', 'rust'),
    deviceId: pref.get('visor.device', null),
    deviceAudioId: pref.get('visor.deviceAudio', null),
    audioMode: pref.get('visor.audioMode', 'all'), // off | all
    audioGain: pref.get('visor.audioGain', 1.5), // 0.5 a 3.0 (padrao 150% para compensar apps baixos no Windows)
    exclude: pref.get('visor.exclude', []), // exes (minusculo) que NAO entram no audio (so desktop)
    presetId: pref.get('visor.preset', DEFAULT_PRESET()),
    bitrate: pref.get('visor.bitrate', getPreset(pref.get('visor.preset', DEFAULT_PRESET())).bitrate),
    replay: pref.get('visor.replay', 0), // 0 = desligado; 30/60 = segundos guardados para o F9 (so desktop)
    camFlip: pref.get('visor.camFlip', false), // camera espelhada (para todos)
    camId: pref.get('visor.cam', null), // camera junto com a tela (null = desligada)
  }))
  const update = useCallback((patch) => {
    setCfg((c) => {
      const next = { ...c, ...(typeof patch === 'function' ? patch(c) : patch) }
      pref.set('visor.kind', next.kind)
      if (next.kind !== 'device') pref.set('visor.screenKind', next.kind)
      pref.set('visor.captureEngineStable', next.engine)
      pref.set('visor.device', next.deviceId)
      pref.set('visor.deviceAudio', next.deviceAudioId)
      pref.set('visor.audioMode', next.audioMode)
      pref.set('visor.audioGain', next.audioGain)
      pref.set('visor.exclude', next.exclude)
      pref.set('visor.preset', next.presetId)
      pref.set('visor.bitrate', next.bitrate)
      pref.set('visor.replay', next.replay)
      pref.set('visor.camFlip', next.camFlip)
      pref.set('visor.cam', next.camId)
      return next
    })
  }, [])
  return [cfg, update]
}

// side: camera ao lado da tela ja no ar. So a lista de dispositivos e Iniciar (a qualidade e a da tela).
export default function SharePanel({ cfg, update, live, open, peers, uplink, apps, nativeCapture, onStart, side = false }) {
  if (side) return (
    <div className="share-panel">
      {open && <DevicePicker cfg={cfg} update={update} preview />}
      <div className="sp-row sp-side">
        <button type="button" className="island-go" aria-label="Iniciar" data-tip="Iniciar" onClick={() => onStart()}><span className="live-dot" /></button>
      </div>
    </div>
  )
  const preset = getPreset(cfg.presetId)
  const fpsOptions = PRESETS.filter((p) => p.res === preset.res).map((p) => p.fps)
  const pickPreset = (res, fps) => {
    const p = PRESETS.find((x) => x.res === res && x.fps === fps) ?? PRESETS.find((x) => x.res === res)
    update({ presetId: p.id })
  }

  return (
    <div className="share-panel">
      {!live && screenCaptureSupported() && cfg.kind !== 'device' && (
        <div className="sp-row sp-head">
          <Segmented
            label="Fonte"
            value={cfg.kind}
            onChange={(kind) => update({ kind, sourceId: null })}
            options={[
              { value: 'monitor', label: 'Tela inteira', tip: 'Tela', icon: <Monitor size={16} strokeWidth={1.75} /> },
              { value: 'window', label: 'Janela', tip: 'Janela', icon: <AppWindow size={16} strokeWidth={1.75} /> },
            ]}
          />
        </div>
      )}

      {!live && open && desktop && cfg.kind !== 'device' && <SourceGrid cfg={cfg} update={update} />}
      {!live && open && cfg.kind === 'device' && <DevicePicker cfg={cfg} update={update} preview />}
      {!live && open && nativeCapture && cfg.kind !== 'device' && <EnginePicker cfg={cfg} update={update} />}
      {cfg.kind !== 'device' && open && <AudioPicker cfg={cfg} update={update} apps={apps} />}
      {open && desktop && window.visor?.clips && replaySupported() && <ReplayPicker cfg={cfg} update={update} />}

      <div className="sp-row">
        <Segmented
          label="Resolucao"
          size="sm"
          value={preset.res}
          onChange={(r) => pickPreset(r, PRESETS.some((p) => p.res === r && p.fps === preset.fps) ? preset.fps : 30)}
          options={['1080', '720', '480'].map((r) => ({ value: r, label: `${r}p`, text: r }))}
        />
        <Segmented
          label="Quadros"
          size="sm"
          value={preset.fps}
          onChange={(f) => pickPreset(preset.res, f)}
          options={fpsOptions.map((f) => ({ value: f, label: `${f} fps`, text: String(f) }))}
        />
      </div>

      <BitrateRow cfg={cfg} update={update} peers={peers} uplink={uplink} live={live} open={open} onStart={onStart} />
    </div>
  )
}

// Replay: guarda os ultimos segundos da transmissao; F9 (mesmo com o jogo em foco) salva o clipe.
function ReplayPicker({ cfg, update }) {
  const options = [[0, 'Desligado'], [30, '30 s'], [60, '1 min']]
  return (
    <Dropdown label="Replay" trigger={
      <>
        <Clapperboard size={14} strokeWidth={1.75} className="dd-lead" />
        <span className="dd-name">{cfg.replay ? 'Replay · F9' : 'Replay'}</span>
        {!!cfg.replay && <span className="dd-meta mono">{cfg.replay === 60 ? '1 min' : '30 s'}</span>}
      </>
    }>
      <ul className="dd-list" role="radiogroup" aria-label="Replay">
        {options.map(([seconds, name]) => {
          const on = (cfg.replay || 0) === seconds
          return (
            <li key={seconds}>
              <button type="button" role="radio" aria-checked={on} className={`dd-row ${on ? 'is-on' : ''}`} onClick={() => update({ replay: seconds })}>
                <span className="dd-check is-radio">{on && <Check size={11} strokeWidth={2.5} />}</span>
                <span className="dd-name">{name}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </Dropdown>
  )
}

function EnginePicker({ cfg, update }) {
  const selected = cfg.engine === 'rust' ? 'rust' : 'chromium'
  return (
    <Dropdown label="Motor de captura" trigger={
      <>
        <Cpu size={14} strokeWidth={1.75} className="dd-lead" />
        <span className="dd-name">{selected === 'rust' ? 'Rust' : 'Chromium'}</span>
      </>
    }>
      <ul className="dd-list" role="radiogroup" aria-label="Motor de captura">
        {Object.entries({ chromium: 'Chromium', rust: 'Rust' }).map(([engine, name]) => {
          const on = engine === selected
          return (
            <li key={engine}>
              <button type="button" role="radio" aria-checked={on} className={`dd-row ${on ? 'is-on' : ''}`} onClick={() => update({ engine })}>
                <span className="dd-check is-radio">{on && <Check size={11} strokeWidth={2.5} />}</span>
                <span className="dd-name">{name}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </Dropdown>
  )
}

// ---------- Dropdown vertical que abre dentro do painel (conceito "Spring dropdown") ----------

function Dropdown({ label, trigger, children }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`dd ${open ? 'is-open' : ''}`}>
      <button type="button" className="dd-trigger" aria-expanded={open} aria-label={label} onClick={() => setOpen((v) => !v)}>
        {trigger}
        <ChevronDown size={14} strokeWidth={1.75} className="dd-chev" />
      </button>
      <div className="dd-body" inert={!open}>
        <div className="dd-inner">{children}</div>
      </div>
    </div>
  )
}

// ---------- Fontes (desktop) ----------

function SourceGrid({ cfg, update }) {
  const [sources, setSources] = useState(null)
  const [spin, setSpin] = useState(false)
  const load = useCallback(async () => {
    setSpin(true)
    setSources(await window.visor.sources())
    setSpin(false)
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const want = cfg.kind === 'monitor' ? 'screen' : 'window'
  const items = (sources ?? []).filter((s) => s.kind === want)

  useEffect(() => {
    if (!cfg.sourceId && want === 'screen' && items[0]) update({ sourceId: items[0].id })
  }, [items, cfg.sourceId, want, update])

  return (
    <div className="sp-block">
      <div className="source-grid">
        {items.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`source ${cfg.sourceId === s.id ? 'is-on' : ''}`}
            style={{ animationDelay: `${i * 30}ms` }}
            aria-label={s.name}
            onClick={() => update({ sourceId: s.id })}
          >
            <span className="source-thumb">{s.thumb ? <img src={s.thumb} alt="" /> : <Monitor size={20} strokeWidth={1.25} />}</span>
            <span className="source-name">
              {s.icon && <img src={s.icon} alt="" className="mono-icon" />}
              <span>{s.name}</span>
            </span>
          </button>
        ))}
        {sources && !items.length && <span className="sp-empty"><AppWindow size={18} strokeWidth={1.25} /></span>}
      </div>
      <IconButton label="Atualizar" className={`sp-refresh ${spin ? 'is-spin' : ''}`} onClick={load} magnetic={false}>
        <RefreshCw size={14} strokeWidth={1.75} />
      </IconButton>
    </div>
  )
}

// ---------- Audio: Mudo / Tudo + apps excluidos ----------

function AudioPicker({ cfg, update, apps }) {
  const off = cfg.audioMode === 'off'
  const gainPct = Math.round((cfg.audioGain ?? 1.5) * 100)
  const running = new Set(apps.map((a) => exeKey(a.exe)))
  // apps rodando + excluidos que nao estao abertos agora (para poder desmarcar)
  const rows = [
    ...apps.filter((a, i, all) => all.findIndex((b) => exeKey(b.exe) === exeKey(a.exe)) === i),
    ...cfg.exclude.filter((x) => !running.has(x)).map((x) => ({ exe: x, offline: true })),
  ]
  const excluded = cfg.exclude.length

  const toggle = (exe) =>
    update((c) => {
      const k = exeKey(exe)
      return { exclude: c.exclude.includes(k) ? c.exclude.filter((x) => x !== k) : [...c.exclude, k] }
    })

  return (
    <Dropdown
      label="Audio"
      trigger={
        <>
          <AudioLines size={14} strokeWidth={1.75} className="dd-lead" />
          {off ? <VolumeX size={14} strokeWidth={1.75} /> : <Speaker size={14} strokeWidth={1.75} />}
          {!off && <span className="dd-gain mono">{gainPct}%</span>}
          {!off && desktop && excluded > 0 && <span className="dd-badge mono">-{excluded}</span>}
        </>
      }
    >
      <div className="dd-audio-head">
        <Segmented
          label="Audio"
          size="sm"
          value={cfg.audioMode}
          onChange={(audioMode) => update({ audioMode })}
          options={[
            { value: 'off', label: 'Mudo', icon: <VolumeX size={14} strokeWidth={1.75} /> },
            { value: 'all', label: 'Tudo', icon: <Speaker size={14} strokeWidth={1.75} /> },
          ]}
        />
        {!off && (
          <label className="audio-gain-control" aria-label="Volume do áudio transmitido">
            <Speaker size={13} strokeWidth={1.75} className="dd-lead" />
            <input
              type="range"
              className="audio-gain-range"
              min={0.25}
              max={3}
              step={0.05}
              value={cfg.audioGain ?? 1.5}
              style={{ '--v': `${(((cfg.audioGain ?? 1.5) - 0.25) / 2.75) * 100}%` }}
              onChange={(e) => update({ audioGain: Number(e.target.value) })}
            />
            <span className="audio-gain-val mono">{gainPct}%</span>
          </label>
        )}
      </div>
      {desktop && (
        <ul className={`dd-list ${off ? 'is-disabled' : ''}`} role="group" aria-label="Sem audio">
          {rows.map((a) => {
            const k = exeKey(a.exe)
            const on = cfg.exclude.includes(k)
            return (
              <li key={k}>
                <button type="button" role="checkbox" aria-checked={on} className={`dd-row ${on ? 'is-on' : ''} ${a.offline ? 'is-offline' : ''}`} onClick={() => toggle(a.exe)}>
                  <span className="dd-check">{on && <VolumeX size={11} strokeWidth={2.25} />}</span>
                  {a.icon ? <img src={a.icon} alt="" className="mono-icon" /> : <AudioLines size={14} strokeWidth={1.75} className="dd-icon" />}
                  <span className="dd-name">{a.exe.replace(/\.exe$/i, '')}</span>
                  {a.title && <span className="dd-sub">{a.title}</span>}
                  {a.active && <span className="chip-level" aria-hidden />}
                </button>
              </li>
            )
          })}
          {!rows.length && (
            <li className="dd-empty">
              <AudioLines size={16} strokeWidth={1.25} />
            </li>
          )}
        </ul>
      )}
    </Dropdown>
  )
}

// ---------- Dispositivos (placa de captura / webcam) ----------

// Previa da camera escolhida antes de transmitir. Mostra exatamente o que os outros vao ver (inclusive espelhada).
function CamPreview({ deviceId, flip, onFlip }) {
  const video = useRef(null)
  const [state, setState] = useState('loading') // loading | live | error
  useEffect(() => {
    let stream = null, alive = true
    setState('loading')
    navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 360 } }, audio: false })
      .then(s => {
        if (!alive) return s.getTracks().forEach(t => t.stop())
        stream = s
        if (video.current) video.current.srcObject = s
        setState('live')
      }, () => alive && setState('error'))
    return () => { alive = false; stream?.getTracks().forEach(t => t.stop()) }
  }, [deviceId])
  return (
    <div className={`cam-preview is-${state}`}>
      <video ref={video} autoPlay playsInline muted style={flip ? { transform: 'scaleX(-1)' } : undefined} />
      {state === 'loading' && <LoaderCircle size={18} className="spin-icon" />}
      {state === 'error' && <VideoOff size={20} strokeWidth={1.5} />}
      <IconButton label="Espelhar" className={`cam-flip ${flip ? 'is-on' : ''}`} active={flip} aria-pressed={flip} magnetic={false} onClick={onFlip}>
        <FlipVertical2 size={15} strokeWidth={1.75} />
      </IconButton>
    </div>
  )
}

function DevicePicker({ cfg, update, preview = false }) {
  const [devs, setDevs] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => listDevices().then((d) => alive && setDevs(d))
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => {
      alive = false
      navigator.mediaDevices.removeEventListener('devicechange', load)
    }
  }, [])

  useEffect(() => {
    if (!devs?.video.length) return
    if (!devs.video.some((v) => v.id === cfg.deviceId)) {
      const v = devs.video[0]
      update({ deviceId: v.id, deviceAudioId: matchAudio(v.label, devs.audio) })
    }
  }, [devs, cfg.deviceId, update])

  if (!devs) return <div className="sp-block sp-loading"><LoaderCircle size={16} className="spin-icon" /></div>
  const audio = devs.audio.find((a) => a.id === cfg.deviceAudioId)
  return (
    <>
      {preview && cfg.deviceId && <CamPreview deviceId={cfg.deviceId} flip={cfg.camFlip} onFlip={() => update({ camFlip: !cfg.camFlip })} />}
      <div className="chips" role="listbox" aria-label="Video">
        {devs.video.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`chip ${cfg.deviceId === v.id ? 'is-on' : ''}`}
            onClick={() => update({ deviceId: v.id, deviceAudioId: matchAudio(v.label, devs.audio) ?? cfg.deviceAudioId })}
          >
            <Video size={14} strokeWidth={1.75} />
            <span>{v.label}</span>
          </button>
        ))}
        {!devs.video.length && <span className="sp-empty"><Video size={18} strokeWidth={1.25} /></span>}
      </div>
      <Dropdown
        label="Audio do dispositivo"
        trigger={
          <>
            <AudioLines size={14} strokeWidth={1.75} className="dd-lead" />
            {audio ? <span className="dd-name">{audio.label}</span> : <VolumeX size={14} strokeWidth={1.75} />}
          </>
        }
      >
        <ul className="dd-list" role="radiogroup" aria-label="Audio do dispositivo">
          <li>
            <button type="button" role="radio" aria-checked={!cfg.deviceAudioId} className={`dd-row ${!cfg.deviceAudioId ? 'is-on' : ''}`} onClick={() => update({ deviceAudioId: null })}>
              <span className="dd-check is-radio">{!cfg.deviceAudioId && <Check size={11} strokeWidth={2.5} />}</span>
              <VolumeX size={14} strokeWidth={1.75} className="dd-icon" />
            </button>
          </li>
          {devs.audio.map((a) => (
            <li key={a.id}>
              <button type="button" role="radio" aria-checked={cfg.deviceAudioId === a.id} className={`dd-row ${cfg.deviceAudioId === a.id ? 'is-on' : ''}`} onClick={() => update({ deviceAudioId: a.id })}>
                <span className="dd-check is-radio">{cfg.deviceAudioId === a.id && <Check size={11} strokeWidth={2.5} />}</span>
                <AudioLines size={14} strokeWidth={1.75} className="dd-icon" />
                <span className="dd-name">{a.label}</span>
              </button>
            </li>
          ))}
        </ul>
        {cfg.deviceAudioId && (
          <label className="audio-gain-control" aria-label="Volume do áudio do dispositivo">
            <Speaker size={13} strokeWidth={1.75} className="dd-lead" />
            <input
              type="range"
              className="audio-gain-range"
              min={0.25}
              max={3}
              step={0.05}
              value={cfg.audioGain ?? 1.5}
              style={{ '--v': `${(((cfg.audioGain ?? 1.5) - 0.25) / 2.75) * 100}%` }}
              onChange={(e) => update({ audioGain: Number(e.target.value) })}
            />
            <span className="audio-gain-val mono">{Math.round((cfg.audioGain ?? 1.5) * 100)}%</span>
          </label>
        )}
      </Dropdown>
    </>
  )
}

// ---------- Cameras do sistema ----------
// Usada pela carta Camera (camera junto com a tela, ao vivo). Mesma lista do Dispositivo.
export function useCameras() {
  const [list, setList] = useState(null)
  useEffect(() => {
    let alive = true, asked = false
    const load = () => navigator.mediaDevices?.enumerateDevices().then(all => {
      if (!alive) return
      const cams = all.filter(d => d.kind === 'videoinput')
      setList(cams.map(d => ({ id: d.deviceId, label: d.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '') })))
      // Sem permissao os nomes vem vazios: pede uma vez (listDevices abre e fecha a camera) e relista.
      if (!asked && cams.some(d => !d.label)) { asked = true; listDevices().then(load, () => {}) }
    }).catch(() => alive && setList([]))
    load()
    navigator.mediaDevices?.addEventListener('devicechange', load)
    return () => { alive = false; navigator.mediaDevices?.removeEventListener('devicechange', load) }
  }, [])
  return list
}

// ---------- Bitrate ----------

const NET_KEY = 'visor.uplink'

function BitrateRow({ cfg, update, peers, uplink, live, open, onStart }) {
  const [net, setNet] = useState(() => {
    const v = pref.get(NET_KEY, null)
    return v && Date.now() - v.t < 3600e3 ? v.bps : null
  })
  const [busy, setBusy] = useState(false)
  const test = useRef(null)
  const others = Math.max(1, peers.length - 1)

  const measure = useCallback(async () => {
    if (test.current) return
    const controller = new AbortController()
    test.current = controller
    setBusy(true)
    try {
      const bps = await measureUpload(controller.signal)
      if (controller.signal.aborted) return
      pref.set(NET_KEY, { bps, t: Date.now() })
      setNet(bps)
    } catch {
      controller.abort()
    } finally {
      test.current = null
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (open && !live) return () => test.current?.abort()
  }, [open, live])

  const auto = useRef(false)
  useEffect(() => {
    if (open && !live && net === null && !auto.current) {
      auto.current = true
      measure()
    }
  }, [open, live, net, measure])

  const limit = live && uplink ? uplink : net ? (net * 0.8) / others : null

  return (
    <div className="sp-row bitrate-row">
      <JellySlider value={cfg.bitrate} limit={limit} onChange={(bitrate) => update({ bitrate })} />
      {limit && <IconButton label="Usar limite medido" magnetic={false} onClick={() => update({bitrate: snapBitrate(limit)})}>
        <ArrowUpToLine size={15} strokeWidth={1.75}/>
      </IconButton>}
      <IconButton label={busy ? 'Medindo' : 'Medir rede'} className={`gauge-btn ${busy ? 'is-busy' : ''}`} disabled={busy || live} onClick={measure} magnetic={false}>
        <Gauge size={16} strokeWidth={1.75} />
      </IconButton>
      {!live && (
        <button type="button" className="island-go" aria-label="Iniciar" data-tip="Iniciar" onClick={() => {
          test.current?.abort()
          onStart()
        }}>
          <span className="live-dot" />
        </button>
      )}
    </div>
  )
}

const LAST = BITRATES.length - 1
const posOf = (i) => (i / LAST) * 100

function posForBps(bps) {
  if (bps >= BITRATES[LAST]) return 100
  if (bps <= BITRATES[0]) return 0
  const i = BITRATES.findIndex((b) => b > bps)
  return posOf(i - 1 + (bps - BITRATES[i - 1]) / (BITRATES[i] - BITRATES[i - 1]))
}

// Slider com detentes e mola (conceito "Jelly slider").
// Durante o arraste o polegar segue o ponteiro sem atraso; ao soltar, assenta no degrau com mola.
function JellySlider({ value, limit, onChange }) {
  const track = useRef(null)
  const [drag, setDrag] = useState(null) // posicao livre (0-100) enquanto arrasta
  const idx = Math.max(0, BITRATES.indexOf(snapBitrate(value)))
  const shown = drag ?? posOf(idx)
  const liveIdx = drag === null ? idx : Math.round((drag / 100) * LAST)
  const liveValue = BITRATES[liveIdx]
  const limitPos = limit ? posForBps(limit) : null

  const posFromEvent = (e) => {
    const r = track.current.getBoundingClientRect()
    return Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))
  }

  const commit = (p) => {
    const b = BITRATES[Math.round((p / 100) * LAST)]
    if (b !== value) onChange(b)
  }

  return (
    <div
      className={`jelly ${drag !== null ? 'is-drag' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="Bitrate"
      aria-valuemin={BITRATES[0]}
      aria-valuemax={BITRATES[LAST]}
      aria-valuenow={liveValue}
      aria-valuetext={fmtMbps(liveValue)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onChange(BITRATES[Math.min(LAST, idx + 1)])
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onChange(BITRATES[Math.max(0, idx - 1)])
      }}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag(posFromEvent(e))
      }}
      onPointerMove={(e) => {
        if (drag === null) return
        setDrag(posFromEvent(e))
      }}
      onPointerUp={(e) => {
        if (drag === null) return
        commit(posFromEvent(e))
        setDrag(null)
      }}
      onPointerCancel={() => setDrag(null)}
      onLostPointerCapture={() => drag !== null && (commit(drag), setDrag(null))}
    >
      <div className="jelly-track" ref={track}>
        <span className="jelly-fill" style={{ width: `${shown}%` }} />
        {BITRATES.map((b, i) => (
          <span key={b} className={`jelly-tick ${i <= liveIdx ? 'is-in' : ''} ${limit && b > limit ? 'is-over' : ''}`} style={{ left: `${posOf(i)}%` }} />
        ))}
        {limitPos !== null && <span className="jelly-limit" style={{ left: `${limitPos}%` }} />}
        <span className="jelly-thumb" style={{ left: `${shown}%` }}>
          <span className="jelly-bubble mono" key={liveValue}>
            {fmtMbps(liveValue)}
          </span>
        </span>
      </div>
    </div>
  )
}
