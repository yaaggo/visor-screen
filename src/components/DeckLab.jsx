import { useState } from 'react'
import ServerHub from './ServerHub.jsx'
import { Avatar } from './ui.jsx'
import './board.css'

// Deck de teste (somente `npm run dev`, em #/deck-teste): o mesmo ServerHub com servidores simulados,
// proprios e de outras pessoas, para testar a lixeira (apagar/sair) e a fisica das cartas. Sem Supabase.
const ME = 'me'
const NAMES = ['estudio', 'gta rp', 'amigos', 'faculdade', 'noite', 'lan', 'trampo', 'cinema', 'xadrez', 'retro']
// Foto gerada localmente (esfera com luz e um anel) para testar a foto em ASCII sem Supabase.
function labPhoto() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')
  g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, 256, 256)
  const light = g.createRadialGradient(100, 90, 10, 128, 128, 110)
  light.addColorStop(0, '#fff'); light.addColorStop(.5, '#888'); light.addColorStop(1, '#111')
  g.fillStyle = light; g.beginPath(); g.arc(128, 128, 92, 0, Math.PI * 2); g.fill()
  g.strokeStyle = '#ddd'; g.lineWidth = 10; g.beginPath(); g.ellipse(128, 136, 120, 34, -.35, 0, Math.PI * 2); g.stroke()
  return c.toDataURL('image/png')
}
const PHOTO = labPhoto()
const start = () => NAMES.map((name, i) => ({ id: 'lab-' + i, name, owner_id: i % 2 ? 'outro' : ME, ...(i === 2 ? { photo_url: PHOTO } : {}) }))
// Presenca simulada (radar): pessoas e transmissoes por servidor.
const ACTIVITY = { 'lab-0': { people: 2, live: 0 }, 'lab-1': { people: 5, live: 1 }, 'lab-2': { people: 3, live: 2 }, 'lab-4': { people: 1, live: 1 } }

export default function DeckLab() {
  const [servers, setServers] = useState(start)
  const [log, setLog] = useState([])
  // Call simulada: #/deck-teste?call (na sala) ou ?live (transmitindo).
  const mode = location.hash.includes('live') ? 'live' : location.hash.includes('call') ? 'call' : null
  const [call, setCall] = useState(mode && { serverId: 'lab-1', name: 'tela', live: mode === 'live' })
  const note = text => setLog(l => [...l.slice(-4), text])
  const remove = verb => async row => { await new Promise(r => setTimeout(r, 150)); setServers(s => s.filter(x => x.id !== row.id)); note(verb + ' ' + row.name) }
  return <div style={{ position: 'fixed', inset: 0, display: 'grid' }}>
    <ServerHub servers={servers} ownerId={ME} onDelete={remove('apagou')} onLeave={remove('saiu de')}
      onOpen={s => note('abriu ' + (s?.name ?? '?'))} onSubmit={async (_, name) => { const row = { id: 'lab-' + Date.now(), name, owner_id: ME }; setServers(s => [...s, row]); return row }}
      editProfile={() => {}} logout={() => setServers(start())}
      call={call && { server: servers.find(x => x.id === call.serverId), name: call.name, live: call.live, connected: true }}
      activity={location.hash.includes('quieto') ? null : ACTIVITY} onResume={() => note('voltou para a call')} onHangup={() => { setCall(null); note('desligou') }}/>
    <div data-lab-log style={{ position: 'fixed', left: 12, top: 44, font: '12px system-ui', color: '#888', pointerEvents: 'none' }}>{log.map((l, i) => <div key={i}>{l}</div>)}</div>
    <div style={{ position: 'fixed', left: 16, bottom: 16 }}>
      <button className="seat-card" aria-label="Sua carta"><span className="seat-art"><Avatar id="lab" name="yago" size={46}/></span><span className="seat-name">yago</span></button>
    </div>
  </div>
}
