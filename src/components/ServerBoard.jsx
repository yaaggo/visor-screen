import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, Plus, Trash2 } from 'lucide-react'
import { Avatar } from './ui.jsx'
import { play } from '../lib/sound.js'
import './board.css'

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const SIDEBAR = 232

// Tabuleiro do servidor: cada canal de transmissao e uma mesa; a sua carta fica embaixo.
// Jogar a carta numa mesa (ou clicar nela) pousa a carta e a mesa se abre ate virar a sala.
// Ao sair de todos os canais, a sala encolhe de volta para a mesa e a carta volta ao lugar.
export default function ServerBoard({ server, channels, people, me, header, profileMenu, callCard, owner, returning, onJoin, onCreate, onDelete }) {
  const root = useRef(null)
  const seat = useRef(null)
  const gesture = useRef(null)
  const [near, setNear] = useState(null)
  const [leaving, setLeaving] = useState(null)
  const [menu, setMenu] = useState(null)
  const [creating, setCreating] = useState(false)

  const tableEl = id => root.current?.querySelector(`[data-table="${CSS.escape(id)}"]`)
  const stageRect = () => {
    const r = root.current.getBoundingClientRect()
    return { left: r.left + SIDEBAR + 16, top: r.top + 72, width: r.width - SIDEBAR - 32, height: r.height - 88 }
  }

  // Volta ao tabuleiro: a sala encolhe ate a mesa e a carta desce para o lugar.
  useLayoutEffect(() => {
    if (!returning || reduced()) return
    const table = tableEl(returning)
    if (!table) return
    play('exit')
    const to = table.querySelector('.table-surface').getBoundingClientRect()
    const from = stageRect()
    const zoom = document.createElement('div')
    zoom.className = 'board-zoom'
    document.body.append(zoom)
    const box = r => ({ left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
    const a = zoom.animate([{ ...box(from), borderRadius: '22px', opacity: 1 }, { ...box(to), borderRadius: '999px', opacity: 1 }, { ...box(to), borderRadius: '999px', opacity: 0 }],
      { duration: 720, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' })
    a.onfinish = () => zoom.remove()
    const card = seat.current
    if (card) {
      const c = card.getBoundingClientRect()
      card.animate([
        { transform: `translate(${to.left + to.width / 2 - c.left - c.width / 2}px,${to.top + to.height / 2 - c.top - c.height / 2}px) scale(.55) rotate(-8deg)`, opacity: 0 },
        { opacity: 1, offset: .35 },
        { transform: 'none', opacity: 1 },
      ], { duration: 760, delay: 180, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' })
    }
    return () => { a.cancel(); zoom.remove() }
  }, [returning])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    addEventListener('pointerdown', close)
    addEventListener('blur', close)
    return () => { removeEventListener('pointerdown', close); removeEventListener('blur', close) }
  }, [menu])

  function join(channel, copy) {
    if (leaving) return
    const table = tableEl(channel.id)
    if (!table || reduced()) { onJoin(channel); return }
    setLeaving(channel.id)
    const surface = table.querySelector('.table-surface').getBoundingClientRect()
    // 1) a carta pousa no centro da mesa
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
    const tx = surface.left + surface.width / 2 - (base.left + c.width / 2)
    const ty = surface.top + surface.height / 2 - (base.top + c.height / 2)
    play('place')
    const landing = card.animate([{ transform: getComputedStyle(card).transform }, { transform: `translate(${tx}px,${ty}px) scale(.62) rotate(0deg)` }],
      { duration: 340, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' })
    landing.onfinish = () => {
      // 2) a mesa se abre ate o tamanho da sala
      play('enter')
      const zoom = document.createElement('div')
      zoom.className = 'board-zoom is-opening'
      document.body.append(zoom)
      const to = stageRect()
      const box = r => ({ left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
      zoom.animate([{ ...box(surface), borderRadius: '999px' }, { ...box(to), borderRadius: '22px' }], { duration: 560, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' })
      card.animate([{ transform: `translate(${tx}px,${ty}px) scale(.62)` },
        { transform: `translate(${to.left + to.width / 2 - base.left - c.width / 2}px,${to.top + to.height - base.top - c.height}px) scale(.8)`, opacity: 0 }],
        { duration: 560, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' })
      setTimeout(() => {
        onJoin(channel)
        zoom.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, delay: 120, fill: 'forwards' }).onfinish = () => zoom.remove()
        card.remove()
      }, 560)
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
  return <section ref={root} className={'server-board' + (leaving ? ' is-leaving' : '') + (gesture.current?.copy ? ' is-dragging' : '')}>
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
          className={'board-table' + (near === c.id ? ' is-near' : '') + (leaving === c.id ? ' is-chosen' : '') + (mine ? ' is-mine' : '')}
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
