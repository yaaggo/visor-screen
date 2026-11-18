import { useCallback, useEffect, useRef, useState } from 'react'
import { AppWindow, AudioLines, Gauge, LoaderCircle, Monitor, RefreshCw, Speaker, Video, VolumeX } from 'lucide-react'
import { BITRATES, PRESETS, fmtMbps, getPreset, snapBitrate } from '../lib/quality.js'
import { desktop } from '../lib/env.js'
import { listDevices, matchAudio } from '../lib/sources.js'
import { measureUpload } from '../lib/net.js'
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

// Estado de configuracao da transmissao (persistido por usuario no navegador/app)
export function useShareConfig() {
  const [cfg, setCfg] = useState(() => ({
    kind: pref.get('visor.kind', 'monitor'), // monitor | window | device
    sourceId: null,
    sourcePid: 0,
    deviceId: pref.get('visor.device', null),
    deviceAudioId: pref.get('visor.deviceAudio', null),
    audio: pref.get('visor.audio', desktop ? [] : true), // desktop: ['system'] | [pid...]; web: boolean
    presetId: pref.get('visor.preset', '1080p60'),
    bitrate: pref.get('visor.bitrate', getPreset(pref.get('visor.preset', '1080p60')).bitrate),
  }))
  const update = useCallback((patch) => {
    setCfg((c) => {
      const next = { ...c, ...(typeof patch === 'function' ? patch(c) : patch) }
      pref.set('visor.kind', next.kind)
      pref.set('visor.device', next.deviceId)
      pref.set('visor.deviceAudio', next.deviceAudioId)
      pref.set('visor.audio', desktop && Array.isArray(next.audio) ? next.audio.filter((a) => a === 'system') : next.audio)
      pref.set('visor.preset', next.presetId)
      pref.set('visor.bitrate', next.bitrate)
      return next
    })
  }, [])
  return [cfg, update]
}

export default function SharePanel({ cfg, update, live, open, peers, uplink, onStart }) {
  const preset = getPreset(cfg.presetId)
  const fpsOptions = PRESETS.filter((p) => p.res === preset.res).map((p) => p.fps)
  const pickPreset = (res, fps) => {
    const p = PRESETS.find((x) => x.res === res && x.fps === fps) ?? PRESETS.find((x) => x.res === res)
    update({ presetId: p.id })
  }

  return (
    <div className="share-panel">
      {!live && (
        <div className="sp-row sp-head">
          <Segmented
            label="Fonte"
            value={cfg.kind}
            onChange={(kind) => update({ kind, sourceId: null, sourcePid: 0 })}
            options={[
              { value: 'monitor', label: 'Tela inteira', tip: 'Tela', icon: <Monitor size={16} strokeWidth={1.75} /> },
              { value: 'window', label: 'Janela', tip: 'Janela', icon: <AppWindow size={16} strokeWidth={1.75} /> },
              { value: 'device', label: 'Dispositivo', tip: 'Dispositivo', icon: <Video size={16} strokeWidth={1.75} /> },
            ]}
          />
        </div>
      )}

      {!live && open && desktop && cfg.kind !== 'device' && <SourceGrid cfg={cfg} update={update} />}
      {!live && open && cfg.kind === 'device' && <DevicePicker cfg={cfg} update={update} />}

      {cfg.kind !== 'device' && open && (desktop ? <AppAudioPicker cfg={cfg} update={update} /> : <WebAudioToggle cfg={cfg} update={update} />)}

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

      <BitrateRow cfg={cfg} update={update} peers={peers} uplink={uplink} live={live} open={open}>
        {!live && (
          <button type="button" className="island-go" aria-label="Iniciar" data-tip="Iniciar" onClick={onStart}>
            <span className="live-dot" />
          </button>
        )}
      </BitrateRow>
    </div>
  )
}

// ---------- Fontes (desktop) ----------

function SourceGrid({ cfg, update }) {
  const [sources, setSources] = useState(null)
  const [spin, setSpin] = useState(false)
  const load = useCallback(async () => {
    setSpin(true)
    const list = await window.visor.sources()
    setSources(list)
    setSpin(false)
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const want = cfg.kind === 'monitor' ? 'screen' : 'window'
  const items = (sources ?? []).filter((s) => s.kind === want)

  // seleciona a primeira tela automaticamente
  useEffect(() => {
    if (!cfg.sourceId && want === 'screen' && items[0]) update({ sourceId: items[0].id, sourcePid: 0 })
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
            onClick={() => update({ sourceId: s.id, sourcePid: s.pid || 0 })}
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

// ---------- Dispositivos (placa de captura / webcam) ----------

function DevicePicker({ cfg, update }) {
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
  return (
    <>
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
      <div className="chips" role="listbox" aria-label="Audio do dispositivo">
        <span className="chips-icon" data-tip="Audio"><AudioLines size={14} strokeWidth={1.75} /></span>
        <button type="button" className={`chip ${!cfg.deviceAudioId ? 'is-on' : ''}`} aria-label="Sem audio" onClick={() => update({ deviceAudioId: null })}>
          <VolumeX size={14} strokeWidth={1.75} />
        </button>
        {devs.audio.map((a) => (
          <button key={a.id} type="button" className={`chip ${cfg.deviceAudioId === a.id ? 'is-on' : ''}`} onClick={() => update({ deviceAudioId: a.id })}>
            <span>{a.label}</span>
          </button>
        ))}
      </div>
    </>
  )
}

// ---------- Audio por aplicativo (desktop) ----------

function AppAudioPicker({ cfg, update }) {
  const [apps, setApps] = useState([])
  const load = useCallback(() => window.visor.audioApps().then(setApps), [])
  useEffect(() => {
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [load])

  const sel = Array.isArray(cfg.audio) ? cfg.audio : []
  const system = sel.includes('system')

  // janela escolhida -> sugere o audio do mesmo processo
  const lastPid = useRef(0)
  useEffect(() => {
    if (!cfg.sourcePid || cfg.sourcePid === lastPid.current) return
    lastPid.current = cfg.sourcePid
    if (apps.some((a) => a.pid === cfg.sourcePid)) update({ audio: [cfg.sourcePid] })
  }, [cfg.sourcePid, apps, update])

  const toggle = (pid) =>
    update((c) => {
      const cur = (Array.isArray(c.audio) ? c.audio : []).filter((x) => x !== 'system')
      return { audio: cur.includes(pid) ? cur.filter((x) => x !== pid) : [...cur, pid] }
    })

  return (
    <div className="chips" role="listbox" aria-label="Audio">
      <span className="chips-icon" data-tip="Audio"><AudioLines size={14} strokeWidth={1.75} /></span>
      <button type="button" className={`chip ${!sel.length ? 'is-on' : ''}`} aria-label="Sem audio" data-tip="Mudo" onClick={() => update({ audio: [] })}>
        <VolumeX size={14} strokeWidth={1.75} />
      </button>
      <button type="button" className={`chip ${system ? 'is-on' : ''}`} aria-label="Sistema" data-tip="Sistema" onClick={() => update({ audio: system ? [] : ['system'] })}>
        <Speaker size={14} strokeWidth={1.75} />
      </button>
      {apps.map((a) => (
        <button
          key={a.pid}
          type="button"
          className={`chip ${sel.includes(a.pid) ? 'is-on' : ''} ${a.active ? 'is-active' : ''}`}
          data-tip={a.title || a.exe}
          onClick={() => toggle(a.pid)}
        >
          {a.icon ? <img src={a.icon} alt="" className="mono-icon" /> : <AudioLines size={14} />}
          <span>{a.exe.replace(/\.exe$/i, '')}</span>
          {a.active && <span className="chip-level" aria-hidden />}
        </button>
      ))}
    </div>
  )
}

function WebAudioToggle({ cfg, update }) {
  const on = cfg.audio === true
  return (
    <div className="chips">
      <span className="chips-icon" data-tip="Audio"><AudioLines size={14} strokeWidth={1.75} /></span>
      <Segmented
        label="Audio"
        size="sm"
        value={on ? 'on' : 'off'}
        onChange={(v) => update({ audio: v === 'on' })}
        options={[
          { value: 'off', label: 'Sem audio', icon: <VolumeX size={14} strokeWidth={1.75} /> },
          { value: 'on', label: 'Com audio', icon: <Speaker size={14} strokeWidth={1.75} /> },
        ]}
      />
    </div>
  )
}

// ---------- Bitrate ----------

const NET_KEY = 'visor.uplink'

function BitrateRow({ cfg, update, peers, uplink, live, open, children }) {
  const [net, setNet] = useState(() => {
    const v = pref.get(NET_KEY, null)
    return v && Date.now() - v.t < 3600e3 ? v.bps : null
  })
  const [busy, setBusy] = useState(false)
  const others = Math.max(1, peers.length - 1)

  const measure = useCallback(async () => {
    setBusy(true)
    try {
      const bps = await measureUpload()
      pref.set(NET_KEY, { bps, t: Date.now() })
      setNet(bps)
      // o mais alto que a rede aguenta: 80% do upload dividido pelos espectadores
      update({ bitrate: snapBitrate((bps * 0.8) / others) })
    } catch {
      /* sem rede */
    }
    setBusy(false)
  }, [others, update])

  // mede sozinho na primeira abertura
  const auto = useRef(false)
  useEffect(() => {
    if (open && !live && net === null && !auto.current) {
      auto.current = true
      measure()
    }
  }, [open, live, net, measure])

  // limite: ao vivo usa a estimativa real do WebRTC por espectador; antes, o teste de upload
  const limit = live && uplink ? uplink : net ? (net * 0.8) / others : null

  return (
    <div className="sp-row bitrate-row">
      <JellySlider value={cfg.bitrate} limit={limit} onChange={(bitrate) => update({ bitrate })} />
      <IconButton label={busy ? 'Medindo' : 'Medir rede'} className={`gauge-btn ${busy ? 'is-busy' : ''}`} onClick={measure} magnetic={false}>
        <Gauge size={16} strokeWidth={1.75} />
      </IconButton>
      {children}
    </div>
  )
}

// Slider com detentes e mola (conceito "Jelly slider")
function JellySlider({ value, limit, onChange }) {
  const track = useRef(null)
  const [drag, setDrag] = useState(false)
  const idx = Math.max(0, BITRATES.indexOf(snapBitrate(value)))
  const pos = (i) => (i / (BITRATES.length - 1)) * 100
  const limitPos = limit ? posFor(limit) : null

  function posFor(bps) {
    if (bps >= BITRATES[BITRATES.length - 1]) return 100
    if (bps <= BITRATES[0]) return 0
    const i = BITRATES.findIndex((b) => b > bps)
    const a = BITRATES[i - 1]
    const b = BITRATES[i]
    return pos(i - 1 + (bps - a) / (b - a))
  }

  const fromEvent = (e) => {
    const r = track.current.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const i = Math.round(t * (BITRATES.length - 1))
    if (BITRATES[i] !== value) onChange(BITRATES[i])
  }

  return (
    <div
      className={`jelly ${drag ? 'is-drag' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="Bitrate"
      aria-valuemin={BITRATES[0]}
      aria-valuemax={BITRATES[BITRATES.length - 1]}
      aria-valuenow={value}
      aria-valuetext={fmtMbps(value)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onChange(BITRATES[Math.min(BITRATES.length - 1, idx + 1)])
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onChange(BITRATES[Math.max(0, idx - 1)])
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag(true)
        fromEvent(e)
      }}
      onPointerMove={(e) => drag && fromEvent(e)}
      onPointerUp={() => setDrag(false)}
      onPointerCancel={() => setDrag(false)}
    >
      <div className="jelly-track" ref={track}>
        <span className="jelly-fill" style={{ width: `${pos(idx)}%` }} />
        {BITRATES.map((b, i) => (
          <span key={b} className={`jelly-tick ${i <= idx ? 'is-in' : ''} ${limit && b > limit ? 'is-over' : ''}`} style={{ left: `${pos(i)}%` }} />
        ))}
        {limitPos !== null && <span className="jelly-limit" style={{ left: `${limitPos}%` }} data-tip={fmtMbps(limit)} />}
        <span className="jelly-thumb" style={{ left: `${pos(idx)}%` }}>
          <span className="jelly-bubble mono" key={value}>
            {fmtMbps(value)}
          </span>
        </span>
      </div>
    </div>
  )
}
