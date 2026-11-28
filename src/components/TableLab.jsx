import { useEffect, useRef, useState } from 'react'
import { Plus, Square, Trash2, UserMinus, UserPlus } from 'lucide-react'
import CardTable from './CardTable.jsx'
import { Stage } from './ScreenChannel.jsx'
import './lab.css'

// Mesa de teste (somente `npm run dev`, em #/mesa-teste): a mesma CardTable da sala,
// alimentada por transmissoes simuladas. Sem login, sem Supabase, sem WebRTC.
const NAMES = ['haroldo', 'mateus', 'ana', 'lucas', 'bia', 'caio', 'duda', 'rafa']
const DELAYS = [[0, 'na hora'], [800, '0,8 s'], [2500, '2,5 s'], [6000, '6 s']]
let seq = 0

function fakeStream(name, hue) {
  const canvas = document.createElement('canvas')
  canvas.width = 640; canvas.height = 360
  const ctx = canvas.getContext('2d')
  const balls = Array.from({ length: 5 }, (_, i) => ({ x: 80 + i * 110, y: 120 + (i % 2) * 90, vx: 2 + i * .6, vy: 1.5 + i * .4, r: 14 + i * 4 }))
  let frame = 0
  const draw = () => {
    frame++
    const g = ctx.createLinearGradient(0, 0, 640, 360)
    g.addColorStop(0, `hsl(${hue} 30% 16%)`); g.addColorStop(1, `hsl(${hue + 40} 25% 8%)`)
    ctx.fillStyle = g; ctx.fillRect(0, 0, 640, 360)
    ctx.fillStyle = `hsl(${hue} 20% 22%)`
    for (let i = 0; i < 8; i++) ctx.fillRect(((i * 97 + frame * 1.5) % 760) - 60, 250 + (i % 3) * 18, 60, 110)
    for (const b of balls) {
      b.x += b.vx; b.y += b.vy
      if (b.x < b.r || b.x > 640 - b.r) b.vx *= -1
      if (b.y < b.r || b.y > 360 - b.r) b.vy *= -1
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fillStyle = `hsl(${hue + b.r * 4} 45% 60%)`; ctx.fill()
    }
    ctx.fillStyle = '#0009'; ctx.fillRect(0, 0, 640, 34)
    ctx.fillStyle = '#fff'; ctx.font = '600 16px system-ui'
    ctx.fillText(name, 14, 23)
    ctx.textAlign = 'right'; ctx.fillText(String(frame).padStart(6, '0'), 626, 23); ctx.textAlign = 'left'
  }
  draw()
  // setInterval (e nao requestAnimationFrame) para seguir desenhando com a aba sem foco
  const timer = setInterval(draw, 33)
  const stream = canvas.captureStream(30)
  return { stream, stop() { clearInterval(timer); stream.getTracks().forEach(t => t.stop()) } }
}

function makePeer(sharing = true) {
  const name = NAMES[seq % NAMES.length] + (seq >= NAMES.length ? ' ' + Math.floor(seq / NAMES.length + 1) : '')
  const hue = (seq * 67) % 360
  seq++
  return { id: 'lab-' + seq, name, hue, sharing, fail: false, delay: 800, device: seq % 4 === 0 ? 'mobile' : 'desktop', sim: sharing ? fakeStream(name, hue) : null,
    cam: sharing && seq === 1 ? fakeStream('câmera', hue + 140) : null } // a primeira pessoa tambem transmite a camera
}

export default function TableLab() {
  const [peers, setPeers] = useState(() => [makePeer(), makePeer(), makePeer(), makePeer(false), makePeer(false)])
  const [watching, setWatching] = useState([]) // [{ id, since, stream }]
  const [peek, setPeek] = useState(null)
  const [own, setOwn] = useState(null)
  const [ownOnTable, setOwnOnTable] = useState(true)
  const [panel, setPanel] = useState(true)
  const [sheet, setSheet] = useState(false)
  const [toasts, setToasts] = useState([])
  const timers = useRef(new Map())
  const live = useRef(peers)
  live.current = peers

  // O StrictMode desmonta e remonta em seguida: so encerra os videos se nao houver remontagem.
  const dispose = useRef(null)
  useEffect(() => {
    clearTimeout(dispose.current)
    return () => {
      dispose.current = setTimeout(() => { for (const p of live.current) p.sim?.stop(); for (const t of timers.current.values()) clearTimeout(t) })
    }
  }, [])

  function connect(id) {
    clearTimeout(timers.current.get(id))
    const p = live.current.find(x => x.id === id)
    if (!p || p.fail) return
    timers.current.set(id, setTimeout(() => {
      const now = live.current.find(x => x.id === id)
      if (now && !now.fail && now.sim) setWatching(w => w.map(v => v.id === id ? { ...v, stream: now.sim.stream } : v))
    }, p.delay))
  }
  function place(id) {
    if (id === 'me') { setOwnOnTable(true); return }
    setPeek(null)
    setWatching(w => w.some(v => v.id === id) ? w : [...w, { id, since: Date.now(), stream: null }])
    connect(id)
  }
  function giveBack(id) {
    if (id === 'me') { setOwnOnTable(false); return }
    clearTimeout(timers.current.get(id))
    setWatching(w => w.filter(v => v.id !== id))
  }
  function patch(id, change) {
    setPeers(list => list.map(p => {
      if (p.id !== id) return p
      const next = { ...p, ...change }
      if ('sharing' in change) {
        if (change.sharing && !p.sim) next.sim = fakeStream(p.name, p.hue)
        if (!change.sharing) { p.sim?.stop(); next.sim = null }
      }
      return next
    }))
    if (change.sharing === false) giveBack(id)
    if (change.fail === false) setTimeout(() => setWatching(w => { if (w.some(v => v.id === id && !v.stream)) connect(id); return w }))
    if (change.fail === true) setWatching(w => w.map(v => v.id === id ? { ...v, stream: null, since: Date.now() } : v))
  }
  function remove(id) {
    live.current.find(p => p.id === id)?.sim?.stop()
    giveBack(id)
    setPeers(list => list.filter(p => p.id !== id))
  }
  function toggleOwn() {
    if (own) { own.stop(); setOwn(null); return }
    setOwnOnTable(true)
    setOwn(fakeStream('você', 210))
  }

  const sharing = peers.filter(p => p.sharing)
  const tiles = [
    ...(own && ownOnTable ? [{ id: 'me', own: true, name: 'você', stream: own.stream, since: 0 }] : []),
    ...watching.map(v => ({ ...v, name: peers.find(p => p.id === v.id)?.name ?? '' })),
  ]
  const hand = [
    ...(own && !ownOnTable ? [{ id: 'me', own: true, name: 'você' }] : []),
    ...sharing.filter(p => !watching.some(v => v.id === p.id)).map(p => ({
      id: p.id, name: p.name, device: p.device,
      peek: peek === p.id && !p.fail ? p.sim?.stream ?? null : null,
    })),
  ]

  return <div className="lab">
    <div className="screen">
      <div className="stage-wrap with-table">
        <CardTable tiles={tiles} hand={hand} audience={peers.filter(p => !p.sharing)} showAdd={!own} toasts={toasts}
          onAdd={() => setSheet(true)} onPlace={place} onReturn={giveBack} onPeek={card => setPeek(card?.id ?? null)}
          onToast={() => setToasts([])}
          shareOpen={sheet} shareTitle={own ? 'Ajustes' : 'Transmitir'} onShareClose={() => setSheet(false)}
          onShareSettings={() => setSheet(true)} onStopShare={toggleOwn}
          shareContent={<div className="lab-sheet">
            <div className="lab-sheet-row"><span>Fonte</span><b>Tela inteira</b></div>
            <div className="lab-sheet-row"><span>Qualidade</span><b>1080p · 60 fps · 12 Mbps</b></div>
            <div className="lab-sheet-row"><span>Áudio</span><b>Tudo</b></div>
            {!own && <button className="lab-go" onClick={() => { toggleOwn(); setSheet(false) }}><span className="live-dot"/>Iniciar</button>}
          </div>}
          renderStage={(tile, tools) => <Stage tools={tools} stream={tile.stream} cam={peers.find(p => p.id === tile.id)?.cam?.stream} local={tile.own} watchingName={tile.name} hasAudio={false}
            stats={tile.stream && !tile.own ? { height: 360, decoded: 30, kbps: 6000 } : null}/>}/>
      </div>
    </div>

    <aside className={'lab-panel' + (panel ? '' : ' is-closed')}>
      <header><b>Mesa de teste</b><button onClick={() => setPanel(!panel)}>{panel ? 'ocultar' : 'controles'}</button></header>
      {panel && <>
        <div className="lab-row">
          <button onClick={() => setPeers(l => [...l, makePeer()])}><Plus size={13}/> transmissão</button>
          <button onClick={() => setPeers(l => [...l, makePeer(false)])}><UserPlus size={13}/> espectador</button>
          <button onClick={() => { const last = [...peers].reverse().find(p => !p.sharing); if (last) remove(last.id) }}><UserMinus size={13}/></button>
        </div>
        <button className="lab-own" onClick={() => {
          const p = peers.find(x => x.sharing) ?? peers[0]
          const id = Date.now()
          setToasts(t => [...t.slice(-2), { id, name: p?.name ?? 'alguém', body: ['bora jogar?', 'que fps é esse', 'olha isso aqui', 'kkkk'][id % 4] }])
          setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000)
        }}>simular mensagem no chat</button>
        <button className="lab-own" onClick={toggleOwn}>{own ? 'parar minha transmissão' : 'simular minha transmissão'}</button>
        <ul>{peers.filter(p => p.sharing || watching.some(v => v.id === p.id)).map(p => <li key={p.id}>
          <span className="lab-name">{p.name}</span>
          <select value={p.delay} onChange={e => patch(p.id, { delay: Number(e.target.value) })} aria-label="Atraso de conexão">
            {DELAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <label><input type="checkbox" checked={p.fail} onChange={e => patch(p.id, { fail: e.target.checked })}/> falha</label>
          <button aria-label="Encerrar transmissão" onClick={() => patch(p.id, { sharing: false })}><Square size={11}/></button>
          <button aria-label="Remover" onClick={() => remove(p.id)}><Trash2 size={12}/></button>
        </li>)}</ul>
        <small>Arraste ou clique numa carta para pôr na mesa. Passe o mouse para espiar. Com falha, o verso avisa após 15 s.</small>
      </>}
    </aside>
  </div>
}
