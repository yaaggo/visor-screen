import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Layers, MessageSquare, Monitor, Pin, PinOff, Plus, Settings2, Smartphone, Square, Star, Undo2, WifiOff, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { Avatar } from './ui.jsx'
import './table.css'
import { play } from '../lib/sound.js'

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const FAIL_AFTER_MS = 15000 // sem video ate aqui, o verso avisa (o WebRTC segue tentando)
const HOLD_MS = 260 // segurar uma transmissao por esse tempo a transforma em carta
const GAP = 10
const SLOT = '__slot'

// Grade que maximiza o maior video 16:9 contido; a ultima linha fica centralizada.
function gridLayout(W, H, ids) {
  const n = ids.length
  let best = null
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c)
    const cw = (W - GAP * (c - 1)) / c, ch = (H - GAP * (r - 1)) / r
    const s = Math.min(cw, ch * 16 / 9)
    if (!best || s > best.s + 0.5) best = { c, r, cw, ch, s }
  }
  const out = {}
  ids.forEach((id, i) => {
    const row = Math.floor(i / best.c), col = i % best.c
    const inRow = row === best.r - 1 ? n - best.c * (best.r - 1) : best.c
    const offset = (W - (inRow * best.cw + GAP * (inRow - 1))) / 2
    out[id] = { x: offset + col * (best.cw + GAP), y: row * (best.ch + GAP), w: best.cw, h: best.ch }
  })
  return out
}

// Destaque: uma transmissao grande e as demais numa faixa (lateral se a mesa for larga, embaixo se for alta).
function spotLayout(W, H, ids, spot) {
  const rest = ids.filter(id => id !== spot)
  const k = rest.length, out = {}
  if (W / H > 1.25) {
    const sw = Math.max(150, Math.min(W * .24, 340))
    out[spot] = { x: 0, y: 0, w: W - sw - GAP, h: H }
    const h = Math.min(sw * 9 / 16, (H - GAP * (k - 1)) / k)
    const top = (H - (k * h + GAP * (k - 1))) / 2
    rest.forEach((id, i) => { out[id] = { x: W - sw, y: top + i * (h + GAP), w: sw, h } })
  } else {
    const sh = Math.max(90, Math.min(H * .24, 200))
    out[spot] = { x: 0, y: 0, w: W, h: H - sh - GAP }
    const w = Math.min(sh * 16 / 9, (W - GAP * (k - 1)) / k)
    const left = (W - (k * w + GAP * (k - 1))) / 2
    rest.forEach((id, i) => { out[id] = { x: left + i * (w + GAP), y: H - sh, w, h: sh } })
  }
  return out
}

function layout(W, H, ids, spot) {
  if (!ids.length || !W || !H) return {}
  return spot && ids.includes(spot) && ids.length > 1 ? spotLayout(W, H, ids, spot) : gridLayout(W, H, ids)
}
const insert = (list, index, id) => [...list.slice(0, index), id, ...list.slice(index)]

// Mesa de cartas da sala de tela.
// mao: quem transmite e nao esta na mesa (+ carta de transmitir) · mesa: transmissoes abertas em posicoes
// calculadas · destaque: uma grande e as outras em faixa · segurar uma transmissao: vira carta de novo.
export default function CardTable({ hand, tiles, audience = [], showAdd, toasts = [], onPlace, onReturn, onPeek, onAdd, onToast, renderStage,
  visible = true, shareOpen = false, shareTitle = 'Transmitir', shareContent = null, onShareClose, onShareSettings, onStopShare }) {
  const felt = useRef(null)
  const handRef = useRef(null)
  const spotChip = useRef(null)
  const addRef = useRef(null)
  const gesture = useRef(null)
  const pending = useRef(new Map()) // id -> { index } | { spot: true } escolhido no arrasto da mao
  const lastRects = useRef({})
  const [size, setSize] = useState({ W: 0, H: 0 })
  const [order, setOrder] = useState([])
  const [spot, setSpot] = useState(null)
  const [drag, setDrag] = useState(null) // { id, kind: 'hand' | 'tile', target }
  // Plateia no canto superior direito do app (barra do canal); sem a barra (mesa de teste), fica sobre a mesa.
  const [headSlot, setHeadSlot] = useState(null)
  useEffect(() => { setHeadSlot(document.getElementById('call-head-slot')) }, [])

  useLayoutEffect(() => {
    const el = felt.current
    const measure = () => { const r = el.getBoundingClientRect(); setSize({ W: Math.round(r.width), H: Math.round(r.height) }) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => () => end(true), [])

  // Ordem da mesa acompanha as transmissoes abertas; novas entram na posicao escolhida no arrasto.
  const tileIds = tiles.map(t => t.id).join('|')
  useEffect(() => {
    setOrder(prev => {
      let next = prev.filter(id => tiles.some(t => t.id === id))
      for (const t of tiles) if (!next.includes(t.id)) {
        const p = pending.current.get(t.id)
        pending.current.delete(t.id)
        if (p?.spot) setSpot(t.id)
        next = insert(next, p?.index != null ? Math.min(p.index, next.length) : next.length, t.id)
      }
      return next
    })
    setSpot(s => s && tiles.some(t => t.id === s) ? s : null)
  }, [tileIds])

  const base = order.filter(id => tiles.some(t => t.id === id) && !(drag?.kind === 'tile' && drag.id === id))
  const target = drag?.target
  const shown = target?.type === 'slot' ? insert(base, target.index, SLOT) : base
  const spotShown = target?.type === 'spot' ? (shown.includes(SLOT) ? SLOT : null) : spot && base.includes(spot) ? spot : null
  const rects = useMemo(() => {
    if (target?.type === 'spot') return layout(size.W, size.H, [SLOT, ...base.filter(id => id !== spot), ...(spot && base.includes(spot) ? [spot] : [])], SLOT)
    return layout(size.W, size.H, shown, spotShown)
  }, [size.W, size.H, shown.join('|'), spotShown, target?.type, spot])
  for (const id of Object.keys(rects)) lastRects.current[id] = rects[id]

  // Alvo do arrasto: mao (so para transmissoes da mesa), chip de destaque, area principal do destaque ou uma posicao.
  function targetAt(x, y, kind, id) {
    const f = felt.current.getBoundingClientRect()
    const chip = spotChip.current?.getBoundingClientRect()
    if (chip && x >= chip.left - 8 && x <= chip.right + 8 && y >= chip.top - 8 && y <= chip.bottom + 8) return { type: 'spot' }
    if (kind === 'tile' && y > f.bottom - 4) return { type: 'hand' }
    if (x < f.left || x > f.right || y < f.top || y > f.bottom) return null
    const ids = order.filter(t => tiles.some(x => x.id === t) && !(kind === 'tile' && t === id))
    const s = spot && ids.includes(spot) ? spot : null
    if (s && ids.length > 1) {
      const main = layout(size.W, size.H, ids, s)[s]
      if (main && x - f.left >= main.x && x - f.left <= main.x + main.w && y - f.top >= main.y && y - f.top <= main.y + main.h) return { type: 'spot' }
    }
    let best = null
    for (let i = 0; i <= ids.length; i++) {
      const r = layout(size.W, size.H, insert(ids, i, SLOT), s)[SLOT]
      if (!r) continue
      const d = Math.hypot(x - f.left - (r.x + r.w / 2), y - f.top - (r.y + r.h / 2))
      if (!best || d < best.d) best = { d, index: i }
    }
    return best ? { type: 'slot', index: best.index } : null
  }

  function end(silent) {
    const g = gesture.current
    if (!g) return
    clearTimeout(g.hold)
    g.detach()
    if (silent) g.copy?.remove()
    if (g.node) g.node.style.opacity = ''
    gesture.current = null
    setDrag(null)
  }

  function follow(g, ev) {
    g.dx = ev.clientX - g.x
    g.dy = ev.clientY - g.y
    g.copy.style.transform = `translate(${ev.clientX - g.x}px,${ev.clientY - g.y}px) rotate(${Math.max(-10, Math.min(10, (ev.clientX - g.x) / 20))}deg)`
    const t = targetAt(ev.clientX, ev.clientY, g.kind, g.id)
    if (JSON.stringify(t) !== JSON.stringify(g.target)) { g.target = t; setDrag({ id: g.id, kind: g.kind, target: t }) }
  }

  function land(g, accept) {
    const copy = g.copy
    const f = felt.current.getBoundingClientRect()
    let to
    if (g.target?.type === 'hand') to = handRef.current?.getBoundingClientRect() ?? f
    else if (accept && rects[SLOT]) to = { left: f.left + rects[SLOT].x, top: f.top + rects[SLOT].y, width: rects[SLOT].w, height: rects[SLOT].h }
    else if (accept) to = f
    else to = g.home
    const from = copy.getBoundingClientRect()
    const tx = (g.dx ?? 0) + to.left + to.width / 2 - (from.left + from.width / 2)
    const ty = (g.dy ?? 0) + to.top + to.height / 2 - (from.top + from.height / 2)
    const flight = copy.animate([
      { transform: getComputedStyle(copy).transform, opacity: 1 },
      { transform: `translate(${tx}px,${ty}px) scale(${accept && g.target?.type !== 'hand' ? 1.2 : .9})`, opacity: accept ? 0 : .9 },
    ], { duration: reduced() ? 1 : 260, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' })
    flight.onfinish = () => copy.remove()
  }

  function drop(ev) {
    const g = gesture.current
    if (!g || ev.pointerId !== g.pointer) return
    clearTimeout(g.hold)
    if (!g.copy) { // clique sem arrastar
      end()
      if (g.kind === 'hand') { play('place'); onPlace(g.id) }
      return
    }
    if (ev.type === 'pointerup') follow(g, ev)
    const t = ev.type === 'pointerup' ? g.target : null
    land(g, !!t)
    g.detach()
    gesture.current = null
    if (g.node) setTimeout(() => { g.node.style.opacity = '' }, reduced() ? 0 : 240)
    play(t?.type === 'hand' || !t ? 'back' : 'place')
    if (g.kind === 'hand') {
      if (t?.type === 'slot') pending.current.set(g.id, { index: t.index })
      if (t?.type === 'spot') pending.current.set(g.id, { spot: true })
      if (t) onPlace(g.id)
    } else if (t?.type === 'hand') {
      onReturn(g.id)
    } else if (t?.type === 'spot') {
      setSpot(g.id)
    } else if (t?.type === 'slot') {
      setOrder(prev => insert(prev.filter(id => id !== g.id), t.index, g.id))
      if (spot === g.id) setSpot(null)
    }
    setDrag(null)
  }

  function listen(g) {
    const move = ev => {
      if (!gesture.current || ev.pointerId !== g.pointer) return
      if (!g.copy) {
        if (Math.hypot(ev.clientX - g.x, ev.clientY - g.y) < 7) return
        lift(g)
      }
      follow(g, ev)
    }
    const up = ev => drop(ev)
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
    g.detach = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
    }
    gesture.current = g
  }

  // Cria a carta que segue o ponteiro. Da mao: copia da carta. Da mesa: a transmissao encolhe ate virar carta.
  function lift(g) {
    if (g.copy) return
    play('lift')
    onPeek?.(null)
    let copy
    if (g.kind === 'hand') {
      copy = g.node.cloneNode(true)
      copy.removeAttribute('style')
      Object.assign(copy.style, { left: g.home.left + 'px', top: g.home.top + 'px', width: g.home.width + 'px', height: g.home.height + 'px' })
      g.node.style.opacity = '0'
    } else {
      const tile = tiles.find(t => t.id === g.id)
      const cw = handRef.current?.querySelector('.hand-card')?.offsetWidth || 84
      const ch = Math.round(cw * 1.34)
      copy = document.createElement('div')
      copy.className = 'hand-card'
      const art = document.createElement('span')
      art.className = 'hand-art'
      if (tile?.stream) {
        const v = document.createElement('video')
        Object.assign(v, { muted: true, autoplay: true, playsInline: true, srcObject: tile.stream })
        art.append(v)
      }
      const cap = document.createElement('span')
      cap.className = 'hand-caption'
      cap.innerHTML = '<span></span>'
      cap.firstChild.textContent = tile?.name ?? ''
      copy.append(art, cap)
      const left = g.x - cw / 2, top = g.y - ch / 2
      Object.assign(copy.style, { left: left + 'px', top: top + 'px', width: cw + 'px', height: ch + 'px' })
      copy.animate([
        { left: g.home.left + 'px', top: g.home.top + 'px', width: g.home.width + 'px', height: g.home.height + 'px', borderRadius: '22px' },
        { left: left + 'px', top: top + 'px', width: cw + 'px', height: ch + 'px', borderRadius: '14px' },
      ], { duration: reduced() ? 1 : 280, easing: 'cubic-bezier(.32,.72,0,1)' })
    }
    copy.classList.add('hand-flying')
    copy.inert = true
    document.body.append(copy)
    g.copy = copy
    setDrag({ id: g.id, kind: g.kind, target: null })
  }

  function handDown(e, card) {
    if (e.button !== 0 || !e.isPrimary || gesture.current) return
    listen({ kind: 'hand', id: card.id, node: e.currentTarget, home: e.currentTarget.getBoundingClientRect(), pointer: e.pointerId, x: e.clientX, y: e.clientY })
  }
  function tileDown(e, tile) {
    if (e.button !== 0 || !e.isPrimary || gesture.current) return
    if (e.target.closest('button, input, select, .stage-hud')) return
    const g = { kind: 'tile', id: tile.id, home: e.currentTarget.getBoundingClientRect(), pointer: e.pointerId, x: e.clientX, y: e.clientY }
    listen(g)
    g.hold = setTimeout(() => { if (gesture.current === g && !g.copy) lift(g) }, HOLD_MS)
  }

  const audienceEl = !!audience.length && <div className="table-audience" aria-label="Na sala">
          {audience.slice(0, 5).map(p => <span key={p.id} data-tip={p.name}><Avatar id={p.profileId} revision={p.photo} name={p.name} size={26}/></span>)}
          {audience.length > 5 && <span className="audience-more">+{audience.length - 5}</span>}
        </div>
  const cards = [...hand, ...(showAdd ? [{ id: '__add', add: true }] : [])]
  const mid = (cards.length - 1) / 2
  const spotlight = spot && base.includes(spot) && base.length > 1

  return (
    <div className={'card-table' + (cards.length ? '' : ' no-hand') + (drag ? ' is-dragging' : '')}>
      <div ref={felt} className={'table-felt' + (tiles.length ? '' : ' is-empty') + (target && target.type !== 'hand' ? ' is-near' : '') + (spotlight ? ' has-spot' : '')}>
        {tiles.map(tile => {
          const r = rects[tile.id] ?? lastRects.current[tile.id]
          const lifted = drag?.kind === 'tile' && drag.id === tile.id
          const isSpot = spot === tile.id && spotlight
          return <TableCard key={tile.id} tile={tile} rect={r} lifted={lifted} spot={isSpot} dim={spotlight && spot !== tile.id}
            onDown={e => tileDown(e, tile)} onReturn={() => onReturn(tile.id)}
            render={leave => renderStage(tile, <>
              <span className="hud-sep"/>
              {tiles.length > 1 && <ToolButton label={isSpot ? 'Tirar do destaque' : 'Destacar'} onClick={() => setSpot(s => s === tile.id ? null : tile.id)}>
                {isSpot ? <PinOff size={15} strokeWidth={1.75}/> : <Pin size={15} strokeWidth={1.75}/>}</ToolButton>}
              {tile.own && onShareSettings && <ToolButton label="Ajustes" onClick={onShareSettings}><Settings2 size={15} strokeWidth={1.75}/></ToolButton>}
              <ToolButton label={tile.own ? 'Recolher' : 'Parar de ver'} onClick={leave}><Undo2 size={15} strokeWidth={1.75}/></ToolButton>
              {tile.own && onStopShare && <ToolButton label="Parar transmissão" className="is-stop" onClick={onStopShare}><Square size={11} fill="currentColor"/></ToolButton>}
            </>)}/>
        })}
        {rects[SLOT] && <div className="table-placeholder" style={{ left: rects[SLOT].x, top: rects[SLOT].y, width: rects[SLOT].w, height: rects[SLOT].h }}/>}
        {!tiles.length && !drag && <div className="table-slot" aria-hidden><Layers size={22} strokeWidth={1.5}/></div>}
        {drag && (tiles.length > (drag.kind === 'tile' ? 1 : 0)) && <div ref={spotChip} className={'spot-chip' + (target?.type === 'spot' ? ' is-on' : '')}><Star size={13}/>Destaque</div>}
        {!headSlot && audienceEl}
        {!!toasts.length && <div className="table-toasts">{toasts.slice(-3).map(t =>
          <button key={t.id} className="table-toast" onClick={onToast}><MessageSquare size={12}/><b>{t.name}</b><span>{t.body}</span></button>)}</div>}
      </div>
      {(!!cards.length || drag?.kind === 'tile') && <div ref={handRef} className={'hand' + (target?.type === 'hand' ? ' is-target' : '')} style={{ '--n': Math.max(1, cards.length) }}>
        {cards.map((card, i) => {
          const d = i - mid
          const style = { '--d': d, '--abs': Math.abs(d), zIndex: card.add ? 0 : i + 1 }
          if (card.add) return <button key={card.id} ref={addRef} className={'hand-card hand-add' + (shareOpen ? ' is-open' : '')} style={style} aria-label="Transmitir" aria-expanded={shareOpen} onClick={onAdd}>
            <span className="hand-art"><Plus size={22} strokeWidth={1.5}/></span>
            <span className="hand-caption">Transmitir</span>
          </button>
          return <button key={card.id} className={'hand-card' + (card.own ? ' is-own' : '')} style={style}
            aria-label={(card.own ? 'Sua transmissão' : card.name) + ' · colocar na mesa'}
            onPointerDown={e => handDown(e, card)}
            onClick={e => { if (e.detail === 0) onPlace(card.id) }}
            onPointerEnter={() => !gesture.current && !card.own && onPeek?.(card)}
            onPointerLeave={() => onPeek?.(null)}>
            <span className="hand-art">
              {card.peek
                ? <video autoPlay muted playsInline ref={node => { if (node && node.srcObject !== card.peek) node.srcObject = card.peek }}/>
                : <Avatar id={card.profileId} revision={card.photo} name={card.name} size={40}/>}
              <i className="live-dot"/>
            </span>
            <span className="hand-caption">
              <span>{card.own ? 'você' : card.name}</span>
              {card.device === 'mobile' ? <Smartphone size={10} aria-hidden/> : <Monitor size={10} aria-hidden/>}
            </span>
          </button>
        })}
      </div>}
      {headSlot && visible && audienceEl && createPortal(audienceEl, headSlot)}
      {shareOpen && <ShareSheet origin={addRef} title={shareTitle} onClose={onShareClose}>{shareContent}</ShareSheet>}
    </div>
  )
}

function ToolButton({ label, className = '', onClick, children }) {
  return <button type="button" className={'icon-btn hud-btn ' + className} aria-label={label} data-tip={label} onClick={onClick}>{children}</button>
}

// A carta + cresce ate virar o painel de opcoes (e encolhe de volta ao fechar).
function ShareSheet({ origin, title, onClose, children }) {
  const ref = useRef(null)
  const closing = useRef(false)
  const [isClosing, setClosing] = useState(false)
  const morph = (reverse) => {
    const el = ref.current, from = origin.current?.getBoundingClientRect()
    if (!el || !from || reduced()) return null
    const to = el.getBoundingClientRect()
    const start = `translate(${from.left - to.left}px,${from.top - to.top}px) scale(${from.width / to.width},${from.height / to.height})`
    const frames = [{ transform: start, borderRadius: '40px' }, { transform: 'none', borderRadius: '22px' }]
    return el.animate(reverse ? frames.reverse() : frames, { duration: reverse ? 300 : 460, easing: reverse ? 'cubic-bezier(.5,0,.75,0)' : 'cubic-bezier(.32,.72,0,1)', fill: 'both' })
  }
  useLayoutEffect(() => { play('open'); morph(false) }, [])
  const close = () => {
    if (closing.current) return
    closing.current = true
    setClosing(true)
    const a = morph(true)
    if (a) a.onfinish = onClose
    else onClose()
  }
  useEffect(() => {
    const key = e => { if (e.key === 'Escape') close() }
    const down = e => { if (!ref.current?.contains(e.target) && !origin.current?.contains(e.target)) close() }
    addEventListener('keydown', key)
    addEventListener('pointerdown', down)
    return () => { removeEventListener('keydown', key); removeEventListener('pointerdown', down) }
  }, [])
  return <div ref={ref} className={'share-sheet' + (isClosing ? ' is-closing' : '')} role="dialog" aria-label={title}>
    <div className="share-sheet-body">
      <div className="share-sheet-head"><span>{title}</span><button aria-label="Voltar para a mão" data-tip="Voltar" onClick={close}><X size={15}/></button></div>
      {children}
    </div>
  </div>
}

// Transmissao aberta: verso enquanto conecta, frente com o video. Segurar transforma em carta.
function TableCard({ tile, rect, lifted, spot, dim, onDown, onReturn, render }) {
  const ready = !!tile.stream
  const [failed, setFailed] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const wasReady = useRef(ready)
  useEffect(() => {
    if (ready && !wasReady.current && !tile.own) play('flip')
    wasReady.current = ready
  }, [ready])
  useEffect(() => { if (failed) play('fail') }, [failed])
  useEffect(() => {
    setFailed(false)
    if (ready) return
    const t = setTimeout(() => setFailed(true), Math.max(0, FAIL_AFTER_MS - (Date.now() - (tile.since ?? Date.now()))))
    return () => clearTimeout(t)
  }, [ready, tile.since])
  const leave = () => {
    if (leaving) return
    play('back')
    setLeaving(true)
    setTimeout(onReturn, reduced() ? 0 : 240)
  }
  const style = rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : { opacity: 0 }
  return <div className={'table-card' + (ready ? ' is-ready' : '') + (leaving ? ' is-leaving' : '') + (lifted ? ' is-lifted' : '') + (spot ? ' is-spot' : '') + (dim ? ' is-dim' : '')}
    style={style} onPointerDown={onDown}>
    <div className="table-card-inner">
      <div className="table-face table-front">{render(leave)}</div>
      <div className="table-face table-back" aria-hidden={ready}>
        <span className={'back-mark' + (failed ? ' is-failed' : '')}>{failed ? <WifiOff size={22} strokeWidth={1.5}/> : <i/>}</span>
        <small>{failed ? 'sem conexão' : tile.name}</small>
        {!ready && <button className="back-leave" onClick={leave}>Parar de ver</button>}
      </div>
    </div>
  </div>
}
