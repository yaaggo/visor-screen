import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Clapperboard, FolderOpen, Pause, Play, Trash2, X } from 'lucide-react'
import { springs } from './ServerHub.jsx'
import './deck.css'
import './clips.css'
import { play } from '../lib/sound.js'
import { attachFanPhysics } from '../lib/fanPhysics.js'
import { createAsciiField } from '../lib/asciiField.js'

// Clipes de replay (Videos\Visor Clips): mesmo leque de cartas do deck, mais novos a esquerda.
// Arrastar uma carta para cima (ou clicar) leva o clipe ao player do centro.
const PER_PAGE = 7
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const fmtTime = s => !Number.isFinite(s) ? '–' : Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0')
const fmtWhen = ms => {
  const d = new Date(ms), today = new Date()
  const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  return d.toDateString() === today.toDateString() ? time : d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '') + ' ' + time
}

export default function ClipsPage({ onBack }) {
  const [clips, setClips] = useState(null)
  const [page, setPage] = useState(0)
  const [current, setCurrent] = useState(null)
  const [near, setNear] = useState(false)
  const hand = useRef(null)
  const stage = useRef(null)
  const canvas = useRef(null)
  const field = useRef(null)
  const gesture = useRef(null)
  const skipClick = useRef(false)

  const load = () => window.visor.clips.list().then(setClips).catch(() => setClips([]))
  useEffect(() => { load() }, [])
  useLayoutEffect(() => attachFanPhysics(hand.current, '.deck-card', {
    positionAt: card => Number(card.style.getPropertyValue('--d')) * Math.min(78, (innerWidth - card.offsetWidth - 40) / (Number(hand.current.style.getPropertyValue('--gaps')) || 1)),
  }), [])
  // Mesmo campo ASCII do deck; parado enquanto um clipe toca.
  useLayoutEffect(() => {
    const f = field.current = createAsciiField(canvas.current, { reduced: reduced() })
    const over = e => f.pointer(e.clientX, e.clientY)
    addEventListener('pointermove', over)
    return () => { f.destroy(); removeEventListener('pointermove', over) }
  }, [])
  useEffect(() => { field.current?.pause(!!current) }, [current])

  const list = clips ?? []
  const lastPage = Math.max(0, Math.ceil(list.length / PER_PAGE) - 1)
  const activePage = Math.min(page, lastPage)
  const cards = list.slice(activePage * PER_PAGE, (activePage + 1) * PER_PAGE)

  function open(clip, from) {
    play('place')
    setCurrent(clip)
    if (from && stage.current && !reduced()) {
      const r = stage.current.getBoundingClientRect()
      field.current?.wave(r.left + r.width / 2, r.top + r.height / 2, { strength: .7, width: 60, life: 800 })
    }
  }

  // Arrastar: uma copia da carta segue o ponteiro; soltar sobre o player (ou bem acima do leque) abre o clipe.
  function down(e, clip) {
    if (e.button !== 0 || !e.isPrimary) return
    const node = e.currentTarget, rect = node.getBoundingClientRect()
    const g = { clip, node, rect, x: e.clientX, y: e.clientY, moved: false, copy: null }
    gesture.current = g
    const over = ev => {
      const s = stage.current.getBoundingClientRect()
      return (ev.clientX >= s.left && ev.clientX <= s.right && ev.clientY >= s.top && ev.clientY <= s.bottom) || ev.clientY < hand.current.getBoundingClientRect().top - 90
    }
    const move = ev => {
      const dx = ev.clientX - g.x, dy = ev.clientY - g.y
      if (!g.moved && Math.hypot(dx, dy) < 6) return
      if (!g.moved) {
        g.moved = true
        play('lift')
        const copy = node.cloneNode(true)
        copy.classList.add('clip-flying')
        copy.removeAttribute('style')
        Object.assign(copy.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' })
        copy.inert = true
        document.body.append(copy)
        node.style.opacity = '0'
        g.copy = copy
      }
      g.copy.style.transform = `translate(${dx}px,${dy}px) rotate(${Math.max(-8, Math.min(8, dx / 25))}deg)`
      setNear(over(ev))
    }
    const up = ev => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up)
      gesture.current = null
      setNear(false)
      if (!g.moved) return
      skipClick.current = true
      const accept = ev.type === 'pointerup' && over(ev)
      const from = g.copy.getBoundingClientRect()
      const to = accept ? stage.current.getBoundingClientRect() : rect
      const flight = g.copy.animate([
        { transform: g.copy.style.transform, opacity: 1 },
        { transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2) + (ev.clientX - g.x)}px,${to.top + to.height / 2 - (from.top + from.height / 2) + (ev.clientY - g.y)}px) scale(${accept ? 1.25 : 1})`, opacity: accept ? 0 : 1 },
      ], { duration: reduced() ? 1 : accept ? 300 : 260, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' })
      flight.onfinish = () => { g.copy.remove(); node.style.opacity = '' }
      if (accept) open(g.clip, true)
      else play('back')
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  async function remove(clip) {
    await window.visor.clips.remove(clip.name)
    play('crumple')
    setCurrent(c => c?.name === clip.name ? null : c)
    load()
  }

  return <section className="server-hub deck-hub clips-hub" aria-label="Clipes" style={springs}>
    <canvas ref={canvas} className="deck-field" aria-hidden/>
    <header className="hub-titlebar clips-bar">
      <div className="clips-tools">
        <button className="clips-icon" aria-label="Voltar ao deck" data-tip="Deck" onClick={onBack}><ArrowLeft size={17}/></button>
        <span className="clips-title"><Clapperboard size={16} strokeWidth={1.8}/>Clipes</span>
        <button className="clips-icon" aria-label="Abrir pasta dos clipes" data-tip="Pasta" onClick={() => window.visor.clips.folder()}><FolderOpen size={16}/></button>
      </div>
    </header>

    <div className="clips-area"><div ref={stage} className={'clips-stage' + (current ? ' has-clip' : '') + (near ? ' is-near' : '')}>
      {current
        ? <ClipPlayer key={current.name} clip={current} onClose={() => setCurrent(null)} onRemove={() => remove(current)}/>
        : <span className="clips-empty" aria-label={list.length ? 'Arraste um clipe para cima' : 'Sem clipes: F9 durante a transmissao'}
            data-tip={list.length ? 'Arraste um clipe para cima' : 'F9 durante a transmissão'}>
            <Clapperboard size={26} strokeWidth={1.3}/>{!list.length && clips && <kbd>F9</kbd>}</span>}
    </div></div>

    <div ref={hand} className="deck-hand clips-hand" style={{ '--gaps': Math.max(1, cards.length - 1) }}>
      {cards.map((clip, i) => {
        const mid = (cards.length - 1) / 2
        return <button key={clip.name} className={'deck-card clip-card' + (current?.name === clip.name ? ' is-playing' : '')} aria-label={'Clipe de ' + fmtWhen(clip.createdAt)}
          style={{ '--d': i - mid, '--abs': Math.abs(i - mid), '--z': cards.length - i }}
          onPointerDown={e => down(e, clip)}
          onClick={e => { if (skipClick.current && e.detail !== 0) { skipClick.current = false; return } open(clip, true) }}>
          <span className="deck-art">
            {clip.thumb ? <img src={clip.thumb} alt="" draggable={false}/> : <Clapperboard size={30} strokeWidth={1.3}/>}
            {clip.duration != null && <span className="clip-dur mono">{fmtTime(clip.duration)}</span>}
          </span>
          <span className="deck-caption">{fmtWhen(clip.createdAt)}</span>
        </button>
      })}
    </div>

    <footer className="deck-footer"><Clapperboard size={15}/> {list.length}
      {lastPage > 0 && <><button disabled={activePage === 0} aria-label="Clipes mais novos" onClick={() => setPage(activePage - 1)}><ChevronLeft size={16}/></button>
        <button disabled={activePage === lastPage} aria-label="Clipes mais antigos" onClick={() => setPage(activePage + 1)}><ChevronRight size={16}/></button></>}
    </footer>
  </section>
}

// Player do clipe: o arquivo vem pela ponte do Electron (ate ~60 MB) e toca de um Blob local.
function ClipPlayer({ clip, onClose, onRemove }) {
  const video = useRef(null)
  const [url, setUrl] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(clip.duration ?? NaN)
  useEffect(() => {
    let alive = true, made
    window.visor.clips.read(clip.name).then(data => {
      if (!alive || !data) return
      made = URL.createObjectURL(new Blob([data], { type: clip.name.endsWith('.mp4') ? 'video/mp4' : 'video/webm' }))
      setUrl(made)
    })
    return () => { alive = false; if (made) URL.revokeObjectURL(made) }
  }, [clip.name])
  // WebM do MediaRecorder nao traz a duracao: pular para o fim faz o navegador descobrir e voltar ao inicio.
  const meta = () => {
    const v = video.current
    if (Number.isFinite(v.duration)) { setDuration(v.duration); return }
    const fix = () => { if (Number.isFinite(v.duration)) { v.removeEventListener('durationchange', fix); setDuration(v.duration); v.currentTime = 0; v.play().catch(() => {}) } }
    v.addEventListener('durationchange', fix)
    v.currentTime = 1e101
  }
  const toggle = () => { const v = video.current; if (v.paused) v.play().catch(() => {}); else v.pause() }
  const pct = Number.isFinite(duration) && duration > 0 ? Math.min(100, time / duration * 100) : 0
  return <div className="clip-player">
    <video ref={video} src={url ?? undefined} autoPlay playsInline onLoadedMetadata={meta} onClick={toggle}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={e => setTime(e.currentTarget.currentTime)}/>
    <div className="clip-bar">
      <button className="clip-btn" aria-label={playing ? 'Pausar' : 'Tocar'} onClick={toggle}>{playing ? <Pause size={15}/> : <Play size={15}/>}</button>
      <input type="range" className="hud-range clip-range" min={0} max={Number.isFinite(duration) ? duration : 0} step={0.05} value={time} aria-label="Posição"
        style={{ '--v': pct + '%' }} onChange={e => { video.current.currentTime = Number(e.target.value); setTime(Number(e.target.value)) }}/>
      <span className="clip-time mono">{fmtTime(time)} / {fmtTime(duration)}</span>
      <button className="clip-btn" aria-label="Mostrar na pasta" data-tip="Mostrar na pasta" onClick={() => window.visor.clips.reveal(clip.name)}><FolderOpen size={15}/></button>
      <button className="clip-btn" aria-label="Mover para a Lixeira" data-tip="Lixeira" onClick={onRemove}><Trash2 size={15}/></button>
      <button className="clip-btn" aria-label="Fechar" data-tip="Fechar" onClick={onClose}><X size={15}/></button>
    </div>
  </div>
}
