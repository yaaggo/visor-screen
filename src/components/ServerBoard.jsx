import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, Plus, Trash2 } from 'lucide-react'
import { Avatar } from './ui.jsx'
import { play } from '../lib/sound.js'
import './board.css'
import { useAsciiField } from '../lib/useAsciiField.js'

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const SIDEBAR = 232

// Tabuleiro do servidor: cada canal de transmissao e uma mesa; a sua carta fica embaixo.
// Jogar a carta numa mesa (ou clicar nela) pousa a carta e a mesa se abre ate virar a sala.
// Ao sair de todos os canais, a sala encolhe de volta para a mesa e a carta volta ao lugar.
export default function ServerBoard({ server, channels, people, me, header, profileMenu, callCard, owner, returning, onJoin, onCreate, onDelete }) {
  const root = useRef(null)
  const canvas = useRef(null)
  // Campo ASCII no fundo do tabuleiro (o mesmo do deck); onda ao tocar o espaco entre as mesas.
  const field = useAsciiField(canvas, { background: t => t.matches?.('.board-tables, .board-seat') })
  const seat = useRef(null)
  const gesture = useRef(null)
  const [near, setNear] = useState(null)
  const [leaving, setLeaving] = useState(null)
  const [menu, setMenu] = useState(null)
  const [creating, setCreating] = useState(false)

  const tableEl = id => root.current?.querySelector(`[data-table="${CSS.escape(id)}"]`)
  const box = r => ({ left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
  const RADIUS = '30px'
  // Area aproximada da mesa da sala (lateral + barra do canal), usada so se nao der para medir.
  const stageGuess = () => {
    const r = root.current.getBoundingClientRect()
    return { left: r.left + SIDEBAR + 32, top: r.top + 56 + 32, width: r.width - SIDEBAR - 64, height: r.height - 56 - 64 - 120 }
  }
  const [landed, setLanded] = useState(null)
  const landing = returning && landed !== returning ? returning.id : null

  // Volta ao tabuleiro: a mesa da sala (medida antes de sair) encolhe ate a mesa do canal,
  // que fica escondida ate a sala pousar nela; a carta desce para o lugar.
  useLayoutEffect(() => {
    if (!returning) return
    const table = tableEl(returning.id)
    if (!table || reduced()) { setLanded(returning); return }
    play('exit')
    const surface = table.querySelector('.table-surface')
    const to = surface.getBoundingClientRect()
    const from = returning.rect ?? stageGuess()
    const zoom = document.createElement('div')
    zoom.className = 'board-zoom'
    document.body.append(zoom)
    const shrink = zoom.animate([{ ...box(from), borderRadius: '22px' }, { ...box(to), borderRadius: RADIUS }],
      { duration: 620, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' })
    shrink.onfinish = () => {
      setLanded(returning)
      zoom.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).onfinish = () => zoom.remove()
    }
    const card = seat.current
    if (card) {
      const c = card.getBoundingClientRect()
      card.animate([
        { transform: `translate(${from.left + from.width / 2 - c.left - c.width / 2}px,${from.top + from.height - c.top - c.height}px) scale(.8)`, opacity: 0 },
        { opacity: 1, offset: .3 },
        { transform: 'none', opacity: 1 },
      ], { duration: 720, delay: 120, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' })
    }
    return () => { shrink.cancel(); zoom.remove() }
  }, [returning])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    addEventListener('pointerdown', close)
    addEventListener('blur', close)
    return () => { removeEventListener('pointerdown', close); removeEventListener('blur', close) }
  }, [menu])

  // Entrar: a carta pousa na mesa; a sala monta escondida por baixo e a mesa se expande ate a mesa
  // real da sala (medida depois de montar). Quando encaixa, a sala aparece e a lateral entra.
  function join(channel, copy) {
    if (leaving) return
    const table = tableEl(channel.id)
    if (!table || reduced()) { onJoin(channel); return }
    setLeaving(channel.id)
    const surfaceEl = table.querySelector('.table-surface')
    const surface = surfaceEl.getBoundingClientRect()
    let card = copy
    if (!card) {
      const s = seat.current.getBoundingClientRect()
      card = seat.current.cloneNode(true)
      card.classList.add('board-flying')
      Object.assign(card.style, { left: s.left + 'px', top: s.top + 'px', width: s.width + 'px', height: s.height + 'px' })
      document.body.append(card)
      seat.current.style.opacity = '0'
    }
    const c = card.getBoundingClientRect()
    const base = { left: parseFloat(card.style.left), top: parseFloat(card.style.top) }
    const at = r => `translate(${r.left + r.width / 2 - base.left - c.width / 2}px,${r.top + r.height / 2 - base.top - c.height / 2}px)`
    play('place')
    card.animate([{ transform: getComputedStyle(card).transform }, { transform: at(surface) + ' scale(.6) rotate(0deg)' }],
      { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' }).onfinish = () => {
      play('enter')
      field.current?.wave(surface.left + surface.width / 2, surface.top + surface.height / 2, { strength: .8, width: 60, life: 800 })
      const zoom = document.createElement('div')
      zoom.className = 'board-zoom is-opening'
      Object.assign(zoom.style, { ...box(surface), borderRadius: RADIUS })
      document.body.append(zoom)
      surfaceEl.style.visibility = 'hidden'
      document.body.classList.add('board-entering')
      onJoin(channel) // a sala monta agora, escondida sob a mesa
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const felt = document.querySelector('.call-session:not([hidden]) .table-felt')?.getBoundingClientRect()
        const to = felt && felt.width > 0 ? felt : stageGuess()
        const grow = zoom.animate([{ ...box(surface), borderRadius: RADIUS }, { ...box(to), borderRadius: '22px' }],
          { duration: 560, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' })
        card.animate([{ transform: at(surface) + ' scale(.6)', opacity: 1 },
          { transform: `translate(${to.left + to.width / 2 - base.left - c.width / 2}px,${to.top + to.height - base.top - c.height * .7}px) scale(.7)`, opacity: 0 }],
          { duration: 520, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' }).onfinish = () => card.remove()
        grow.onfinish = reveal
      }))
      // Se a animacao nao terminar (aba em segundo plano, app trocado no celular), a sala aparece mesmo assim.
      const guard = setTimeout(reveal, 1400)
      let revealed = false
      function reveal() {
        if (revealed) return
        revealed = true
        clearTimeout(guard)
        card.remove()
        document.body.classList.remove('board-entering')
        document.body.classList.add('board-revealing')
        setTimeout(() => document.body.classList.remove('board-revealing'), 700)
        zoom.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, fill: 'forwards' }).onfinish = () => zoom.remove()
        setTimeout(() => zoom.remove(), 600)
      }
    }
  }

  // Arrastar a propria carta ate uma mesa.
  function down(e) {
    if (e.button !== 0 || !e.isPrimary || leaving) return
    const node = seat.current
    const home = node.getBoundingClientRect()
    const g = { x: e.clientX, y: e.clientY, pointer: e.pointerId, copy: null, target: null }
    const over = (x, y) => {
      for (const t of root.current.querySelectorAll('[data-table]')) {
        const r = t.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return t.dataset.table
      }
      return null
    }
    const move = ev => {
      if (ev.pointerId !== g.pointer) return
      const dx = ev.clientX - g.x, dy = ev.clientY - g.y
      if (!g.copy) {
        if (Math.hypot(dx, dy) < 6) return
        play('lift')
        g.copy = node.cloneNode(true)
        g.copy.classList.add('board-flying')
        Object.assign(g.copy.style, { left: home.left + 'px', top: home.top + 'px', width: home.width + 'px', height: home.height + 'px' })
        document.body.append(g.copy)
        node.style.opacity = '0'
      }
      g.copy.style.transform = `translate(${dx}px,${dy}px) rotate(${Math.max(-12, Math.min(12, dx / 16))}deg)`
      const t = over(ev.clientX, ev.clientY)
      if (t !== g.target) { g.target = t; setNear(t) }
    }
    const up = ev => {
      if (ev.pointerId !== g.pointer) return
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up)
      gesture.current = null
      setNear(null)
      if (!g.copy) return
      const channel = ev.type === 'pointerup' && channels.find(c => c.id === g.target)
      if (channel) { join(channel, g.copy); return }
      play('back')
      const back = g.copy.animate([{ transform: g.copy.style.transform }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' })
      back.onfinish = () => { g.copy.remove(); node.style.opacity = '' }
    }
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up)
    gesture.current = g
  }

  const total = people.length
  return <section ref={root} className={'server-board' + (leaving ? ' is-leaving' : '') + (returning ? ' is-returning' : '')}>
    <canvas ref={canvas} className="board-field" aria-hidden/>
    <header className="board-bar">
      {header}
      <span className="board-meta">{channels.length} {channels.length === 1 ? 'mesa' : 'mesas'} · {total} {total === 1 ? 'pessoa' : 'pessoas'}</span>
      <div className="board-bar-end">{profileMenu}</div>
    </header>

    <div className="board-tables" style={{ '--count': channels.length + (owner ? 1 : 0) }}>
      {channels.map((c, i) => {
        const here = people.filter(p => p.channel === c.id)
        const live = here.filter(p => p.sharing), crowd = here.filter(p => !p.sharing)
        const mine = here.some(p => p.id === me.id || p.endpointId === me.id)
        return <button key={c.id} data-table={c.id} style={{ '--i': i }}
          className={'board-table' + (near === c.id ? ' is-near' : '') + (leaving === c.id ? ' is-chosen' : '') + (mine ? ' is-mine' : '') + (landing === c.id ? ' is-landing' : '')}
          onClick={() => join(c)}
          onContextMenu={e => { if (!owner) return; e.preventDefault(); setMenu({ id: c.id, x: e.clientX, y: e.clientY }) }}>
          <span className="table-surface">
            <span className="table-rim"/>
            {live.length ? <span className="table-hand" style={{ '--n': Math.min(live.length, 5) }}>{live.slice(0, 5).map((p, k) =>
              <span key={p.endpointId ?? p.id} className="table-card-mini" style={{ '--d': k - (Math.min(live.length, 5) - 1) / 2 }} data-tip={p.name}>
                <Avatar id={p.profileId ?? p.id} revision={p.photo} name={p.name} size={26}/><i className="live-dot"/>
              </span>)}</span>
              : <span className="table-empty"/>}
            <span className="table-seats">{crowd.slice(0, 6).map((p, k) =>
              <span key={p.endpointId ?? p.id} style={{ '--k': k, '--m': Math.min(crowd.length, 6) }} data-tip={p.name}>
                <Avatar id={p.profileId ?? p.id} revision={p.photo} name={p.name} size={24}/></span>)}</span>
          </span>
          <span className="table-label"><b>{c.name}</b><small>{live.length ? `${live.length} ao vivo` : here.length ? `${here.length} na mesa` : 'vazia'}</small></span>
        </button>
      })}
      {owner && <div className={'board-table is-new' + (creating ? ' is-creating' : '')} style={{ '--i': channels.length }}>
        {creating
          ? <NewTable onDone={() => setCreating(false)} onCreate={onCreate}/>
          : <button className="table-surface" aria-label="Nova mesa" onClick={() => setCreating(true)}><span className="table-rim"/><Plus size={22} strokeWidth={1.5}/></button>}
        <span className="table-label"><b>Nova mesa</b><small>canal de transmissão</small></span>
      </div>}
    </div>

    <footer className="board-seat">
      {callCard && <div className="board-call">{callCard}</div>}
      <button ref={seat} className="seat-card" onPointerDown={down} aria-label="Sua carta · arraste até uma mesa">
        <span className="seat-art"><Avatar id={me.profileId} revision={me.photo} name={me.name} size={46}/></span>
        <span className="seat-name">{me.name}</span>
      </button>
    </footer>

    {menu && <div className="board-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={e => e.stopPropagation()}>
      <button onClick={() => { onDelete(menu.id); setMenu(null) }}><Trash2 size={14}/>Apagar mesa</button>
    </div>}
  </section>
}

function NewTable({ onCreate, onDone }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  return <form className="table-surface table-form" onSubmit={async e => {
    e.preventDefault()
    const v = name.trim()
    if (!v || busy) return
    setBusy(true)
    const ok = await onCreate(v)
    setBusy(false)
    if (ok) onDone()
  }}>
    <span className="table-rim"/>
    <input autoFocus maxLength={24} placeholder="nome da mesa" value={name} onChange={e => setName(e.target.value)}
      onKeyDown={e => { if (e.key === 'Escape') onDone() }} onBlur={() => { if (!name.trim()) onDone() }}/>
    <button aria-label="Criar mesa" disabled={!name.trim() || busy}><ArrowRight size={15}/></button>
  </form>
}
