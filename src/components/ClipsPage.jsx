import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Clapperboard, FolderOpen, Pause, Play, Trash2, Volume2, VolumeX, X } from 'lucide-react'
import { springs } from './ServerHub.jsx'
import './deck.css'
import './clips.css'
import { play } from '../lib/sound.js'
import { attachFanPhysics } from '../lib/fanPhysics.js'
import { createAsciiField } from '../lib/asciiField.js'
import { nav } from '../lib/nav.js'

// Clipes de replay (Videos\Visor Clips): mesmo leque de cartas do deck, mais novos a esquerda.
// No centro, uma mesa do tamanho de uma carta: soltar (ou clicar) uma carta nela abre o clipe e a mesa cresce
// ate o tamanho do video; puxar o video para fora encolhe a mesa e o clipe volta a ser carta; outra carta
// solta na mesa troca de video.
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
  const [outgoing, setOutgoing] = useState(null) // player que sai quando outra carta entra na mesa
  const [near, setNear] = useState(false)
  const [phase, setPhase] = useState('enter') // enter -> idle -> leave
  const root = useRef(null)
  const hand = useRef(null)
  const slot = useRef(null)
  const canvas = useRef(null)
  const field = useRef(null)
  const skipClick = useRef(false)
  const currentRef = useRef(null)
  currentRef.current = current

  const load = () => window.visor.clips.list().then(setClips).catch(() => setClips([]))
  useEffect(() => { load() }, [])
  useLayoutEffect(() => attachFanPhysics(hand.current, '.deck-card', {
    positionAt: card => Number(card.style.getPropertyValue('--d')) * Math.min(78, (innerWidth - card.offsetWidth - 40) / (Number(hand.current.style.getPropertyValue('--gaps')) || 1)),
  }), [])
  // Mesmo campo ASCII do deck (onda ao tocar o fundo); para depois que um clipe comeca a tocar.
  useLayoutEffect(() => {
    const f = field.current = createAsciiField(canvas.current, { reduced: reduced() })
    const over = e => { if (e.pointerType !== 'touch') f.pointer(e.clientX, e.clientY) }
    const out = e => { if (!e.relatedTarget) f.leave() }
    const tap = e => { if (e.target === root.current || e.target === canvas.current || e.target.classList?.contains('clips-area')) f.wave(e.clientX, e.clientY, { strength: .38, width: 34, life: 950, speed: 420 }) }
    addEventListener('pointermove', over)
    document.addEventListener('pointerout', out)
    root.current.addEventListener('pointerdown', tap)
    const node = root.current
    return () => { f.destroy(); removeEventListener('pointermove', over); document.removeEventListener('pointerout', out); node.removeEventListener('pointerdown', tap) }
  }, [])
  useEffect(() => {
    if (!current) { field.current?.pause(false); return }
    const t = setTimeout(() => field.current?.pause(true), 1100)
    return () => clearTimeout(t)
  }, [current])
  useLayoutEffect(() => { const t = setTimeout(() => setPhase(p => p === 'enter' ? 'idle' : p), 1000); return () => clearTimeout(t) }, [])
  useEffect(() => {
    const key = e => { if (e.key === 'Escape' && currentRef.current) { play('back'); setCurrent(null) } }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [])

  const list = clips ?? []
  const lastPage = Math.max(0, Math.ceil(list.length / PER_PAGE) - 1)
  const activePage = Math.min(page, lastPage)
  const cards = list.slice(activePage * PER_PAGE, (activePage + 1) * PER_PAGE)

  function back() {
    if (phase === 'leave') return
    play('open')
    setPhase('leave')
    nav.from = 'clips'
    setTimeout(onBack, reduced() ? 0 : 300)
  }

  // A carta bate na mesa: onda pela janela (como ao abrir um servidor), onda no campo e um pulo da mesa.
  function impact() {
    play('wave')
    const el = slot.current
    if (!el || reduced()) return
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2
    const wave = document.createElement('div')
    wave.className = 'deck-wave is-global'
    wave.style.setProperty('--cx', cx + 'px')
    wave.style.setProperty('--cy', cy + 'px')
    document.body.append(wave)
    setTimeout(() => wave.remove(), 1100)
    field.current?.wave(cx, cy, { strength: .9, width: 64, life: 820 })
    el.animate([{ scale: .94 }, { scale: 1.025, offset: .3 }, { scale: 1 }], { duration: 620, easing: 'cubic-bezier(.2,.9,.25,1)' })
  }
  function open(clip) {
    const was = currentRef.current
    if (was?.name === clip.name) return
    if (was) { setOutgoing(was); setTimeout(() => setOutgoing(o => o === was ? null : o), 480) }
    setCurrent(clip)
    impact()
  }

  const overSlot = ev => {
    const s = slot.current.getBoundingClientRect(), pad = 36
    return ev.clientX >= s.left - pad && ev.clientX <= s.right + pad && ev.clientY >= s.top - pad && ev.clientY <= s.bottom + pad
  }
  // Voo da carta (copia no body) ate a mesa (aceito) ou de volta a um retangulo.
  function flight(copy, ev, start, accept, home) {
    const from = copy.getBoundingClientRect()
    const to = accept ? slot.current.getBoundingClientRect() : home
    const dx = ev.clientX - start.x, dy = ev.clientY - start.y
    const anim = copy.animate([
      { transform: copy.style.transform, opacity: 1 },
      { transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2) + dx}px,${to.top + to.height / 2 - (from.top + from.height / 2) + dy}px) scale(${accept ? 1.12 : 1})`, opacity: accept ? 0 : 1 },
    ], { duration: reduced() ? 1 : accept ? 280 : 300, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' })
    return anim
  }

  // Arrastar uma carta do leque: uma copia segue o ponteiro; soltar sobre a mesa abre (ou troca) o clipe.
  function down(e, clip) {
    if (e.button !== 0 || !e.isPrimary || phase === 'leave') return
    const node = e.currentTarget, rect = node.getBoundingClientRect()
    const g = { x: e.clientX, y: e.clientY, moved: false, copy: null }
    const move = ev => {
      const dx = ev.clientX - g.x, dy = ev.clientY - g.y
      if (!g.moved && Math.hypot(dx, dy) < 6) return
      if (!g.moved) {
        g.moved = true
        play('lift')
        const copy = node.cloneNode(true)
        copy.classList.add('clip-flying')
        copy.removeAttribute('style')
        Object.assign(copy.style, { left: rect.left + 'px', top: rect.top + 'px', width: node.offsetWidth + 'px', height: node.offsetHeight + 'px' })
        copy.inert = true
        document.body.append(copy)
        node.style.opacity = '0'
        g.copy = copy
      }
      g.copy.style.transform = `translate(${dx}px,${dy}px) rotate(${Math.max(-8, Math.min(8, dx / 25))}deg)`
      setNear(overSlot(ev))
    }
    const up = ev => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up)
      setNear(false)
      if (!g.moved) return
      skipClick.current = true
      node.blur() // sem foco preso, o leque fecha como no deck
      const accept = ev.type === 'pointerup' && overSlot(ev)
      const anim = flight(g.copy, ev, g, accept, rect)
      anim.onfinish = () => { g.copy.remove(); node.style.opacity = '' }
      if (accept) open(clip)
      else play('back')
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  // Puxar o video para fora da mesa: vira carta sob o ponteiro e a mesa encolhe; solta fora = volta ao leque.
  function pull(e) {
    const clip = currentRef.current
    if (e.button !== 0 || !e.isPrimary || !clip) return
    const g = { x: e.clientX, y: e.clientY, copy: null }
    const move = ev => {
      const dx = ev.clientX - g.x, dy = ev.clientY - g.y
      if (!g.copy) {
        if (Math.hypot(dx, dy) < 8) return
        play('lift')
        g.copy = clipCard(clip, g.x, g.y)
        setCurrent(null)
      }
      g.copy.style.transform = `translate(${dx}px,${dy}px) rotate(${Math.max(-8, Math.min(8, dx / 25))}deg)`
      setNear(overSlot(ev))
    }
    const up = ev => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up)
      setNear(false)
      if (!g.copy) return
      const accept = ev.type === 'pointerup' && overSlot(ev)
      const home = hand.current.querySelector(`[data-clip="${CSS.escape(clip.name)}"]`)?.getBoundingClientRect() ?? hand.current.getBoundingClientRect()
      const anim = flight(g.copy, ev, g, accept, home)
      anim.onfinish = () => g.copy.remove()
      if (accept) open(clip)
      else play('back')
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }
  // Carta do clipe montada no DOM (o clipe pode estar em outra pagina do leque), centrada no ponteiro.
  function clipCard(clip, x, y) {
    const w = hand.current.querySelector('.deck-card')?.offsetWidth || 130, h = Math.round(w * 1.31)
    const card = document.createElement('div')
    card.className = 'deck-card clip-card clip-flying'
    const art = document.createElement('span')
    art.className = 'deck-art'
    if (clip.thumb) { const img = document.createElement('img'); img.src = clip.thumb; img.alt = ''; art.append(img) }
    if (clip.duration != null) { const dur = document.createElement('span'); dur.className = 'clip-dur mono'; dur.textContent = fmtTime(clip.duration); art.append(dur) }
    const cap = document.createElement('span')
    cap.className = 'deck-caption'
    cap.textContent = fmtWhen(clip.createdAt)
    card.append(art, cap)
    Object.assign(card.style, { left: x - w / 2 + 'px', top: y - h / 2 + 'px', width: w + 'px', height: h + 'px' })
    card.inert = true
    document.body.append(card)
    if (!reduced()) card.animate([{ scale: 1.6, opacity: .4 }, { scale: 1, opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' })
    return card
  }

  async function remove(clip) {
    await window.visor.clips.remove(clip.name)
    play('crumple')
    setCurrent(c => c?.name === clip.name ? null : c)
    load()
  }

  return <section ref={root} className={'server-hub deck-hub clips-hub is-' + phase} aria-label="Clipes" style={springs}>
    <canvas ref={canvas} className="deck-field" aria-hidden/>
    <header className="hub-titlebar clips-bar">
      <div className="clips-tools">
        <button className="clips-icon" aria-label="Voltar ao deck" data-tip="Deck" onClick={back}><ArrowLeft size={17}/></button>
        <span className="clips-title"><Clapperboard size={16} strokeWidth={1.8}/>Clipes</span>
        <button className="clips-icon" aria-label="Abrir pasta dos clipes" data-tip="Pasta" onClick={() => window.visor.clips.folder()}><FolderOpen size={16}/></button>
      </div>
    </header>

    <div className="clips-area">
      <div ref={slot} className={'clips-slot' + (current ? ' has-clip' : '') + (near ? ' is-near' : '')}>
        <span className="clips-rim" aria-hidden/>
        {!current && <span className="clips-empty" aria-label={list.length ? 'Arraste um clipe para a mesa' : 'Sem clipes: F9 durante a transmissão'}
          data-tip={list.length ? 'Arraste um clipe para a mesa' : 'F9 durante a transmissão'}>
          <Clapperboard size={24} strokeWidth={1.3}/>{!list.length && clips && <kbd>F9</kbd>}</span>}
        {outgoing && <ClipPlayer key={'out:' + outgoing.name} clip={outgoing} leaving/>}
        {current && <ClipPlayer key={current.name} clip={current} onPull={pull} onClose={() => { play('back'); setCurrent(null) }} onRemove={() => remove(current)}/>}
      </div>
    </div>

    <div ref={hand} className="deck-hand clips-hand" style={{ '--gaps': Math.max(1, cards.length - 1) }}>
      {cards.map((clip, i) => {
        const mid = (cards.length - 1) / 2, z = cards.length - i
        return <button key={clip.name} data-clip={clip.name} data-z={z} className={'deck-card clip-card' + (current?.name === clip.name ? ' is-playing' : '')} aria-label={'Clipe de ' + fmtWhen(clip.createdAt)}
          style={{ '--d': i - mid, '--abs': Math.abs(i - mid), '--z': z, '--i': i }}
          onPointerDown={e => down(e, clip)}
          onClick={e => { if (skipClick.current && e.detail !== 0) { skipClick.current = false; return } open(clip) }}>
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

// Player do clipe: o arquivo vem pela ponte do Electron e toca de um Blob local, com som.
// leaving: o player antigo que esmaece enquanto o novo entra (troca de clipe na mesa).
function ClipPlayer({ clip, onPull, onClose, onRemove, leaving = false }) {
  const video = useRef(null)
  const [url, setUrl] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
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
  useEffect(() => { if (leaving) video.current?.pause() }, [leaving])
  // WebM do MediaRecorder nao traz a duracao: pular para o fim faz o navegador descobrir e voltar ao inicio.
  const meta = () => {
    const v = video.current
    if (Number.isFinite(v.duration)) { setDuration(v.duration); return }
    const fix = () => { if (Number.isFinite(v.duration)) { v.removeEventListener('durationchange', fix); setDuration(v.duration); v.currentTime = 0; if (!leaving) v.play().catch(() => {}) } }
    v.addEventListener('durationchange', fix)
    v.currentTime = 1e101
  }
  const toggle = () => { const v = video.current; if (v.paused) v.play().catch(() => {}); else v.pause() }
  const pct = Number.isFinite(duration) && duration > 0 ? Math.min(100, time / duration * 100) : 0
  return <div className={'clip-player' + (leaving ? ' is-out' : '')} inert={leaving || undefined}>
    <video ref={video} src={url ?? undefined} autoPlay={!leaving} muted={muted} playsInline onLoadedMetadata={meta} onClick={toggle} onPointerDown={onPull}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={e => setTime(e.currentTarget.currentTime)}/>
    {!leaving && <div className="clip-bar">
      <button className="clip-btn" aria-label={playing ? 'Pausar' : 'Tocar'} onClick={toggle}>{playing ? <Pause size={15}/> : <Play size={15}/>}</button>
      <input type="range" className="hud-range clip-range" min={0} max={Number.isFinite(duration) ? duration : 0} step={0.05} value={time} aria-label="Posição"
        style={{ '--v': pct + '%' }} onChange={e => { video.current.currentTime = Number(e.target.value); setTime(Number(e.target.value)) }}/>
      <span className="clip-time mono">{fmtTime(time)} / {fmtTime(duration)}</span>
      <button className="clip-btn" aria-label={muted ? 'Ativar som' : 'Mudo'} data-tip={muted ? 'Ativar som' : 'Mudo'} onClick={() => setMuted(m => !m)}>{muted ? <VolumeX size={15}/> : <Volume2 size={15}/>}</button>
      <button className="clip-btn" aria-label="Mostrar na pasta" data-tip="Mostrar na pasta" onClick={() => window.visor.clips.reveal(clip.name)}><FolderOpen size={15}/></button>
      <button className="clip-btn" aria-label="Mover para a Lixeira" data-tip="Lixeira" onClick={onRemove}><Trash2 size={15}/></button>
      <button className="clip-btn" aria-label="Tirar da mesa" data-tip="Tirar da mesa" onClick={onClose}><X size={15}/></button>
    </div>}
  </div>
}
