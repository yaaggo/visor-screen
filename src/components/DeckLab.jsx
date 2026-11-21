import { useState } from 'react'
import ServerHub from './ServerHub.jsx'
import { Avatar } from './ui.jsx'
import './board.css'

// Deck de teste (somente `npm run dev`, em #/deck-teste): o mesmo ServerHub com servidores simulados,
// proprios e de outras pessoas, para testar a lixeira (apagar/sair) e a fisica das cartas. Sem Supabase.
const ME = 'me'
const NAMES = ['estudio', 'gta rp', 'amigos', 'faculdade', 'noite', 'lan', 'trampo', 'cinema', 'xadrez', 'retro']
const start = () => NAMES.map((name, i) => ({ id: 'lab-' + i, name, owner_id: i % 2 ? 'outro' : ME }))

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
      onResume={() => note('voltou para a call')} onHangup={() => { setCall(null); note('desligou') }}/>
    <div data-lab-log style={{ position: 'fixed', left: 12, top: 44, font: '12px system-ui', color: '#888', pointerEvents: 'none' }}>{log.map((l, i) => <div key={i}>{l}</div>)}</div>
    <div style={{ position: 'fixed', left: 16, bottom: 16 }}>
      <button className="seat-card" aria-label="Sua carta"><span className="seat-art"><Avatar id="lab" name="yago" size={46}/></span><span className="seat-name">yago</span></button>
    </div>
  </div>
}
