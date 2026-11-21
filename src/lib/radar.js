import { useEffect, useState } from 'react'
import { endpointId } from './presence.js'
import { acquireTopic, presenceList } from './topics.js'

// Resumo da presenca de um servidor: pessoas nas mesas (por perfil) e transmissoes (por instancia).
// A propria instancia fica de fora: o deck mostra o que os outros estao fazendo.
export function summarize(entries) {
  const people = new Set(), live = new Set()
  for (const meta of entries) {
    const id = meta.endpointId ?? meta.id
    if (id === endpointId) continue
    people.add(meta.profileId ?? id)
    if (meta.sharing) live.add(id)
  }
  return people.size ? { people: people.size, live: live.size } : null
}

// Radar do deck: enquanto o deck esta aberto, ouve (sem publicar nada) a presenca 'calls:<id>' de cada servidor.
// Os canais sao os compartilhados de topics.js: o da call em andamento e o mesmo do diretorio, e voltar do
// deck para um servidor reaproveita o canal ja assinado.
export function useRadar(ids, enabled) {
  const [radar, setRadar] = useState({})
  const key = enabled ? ids.join(',') : ''
  useEffect(() => {
    setRadar({})
    if (!key) return
    let alive = true
    const topics = key.split(',').map(id => acquireTopic('calls:' + id, {
      onSync: state => {
        if (!alive) return
        const s = summarize(presenceList(state))
        setRadar(r => {
          if (JSON.stringify(r[id] ?? null) === JSON.stringify(s)) return r
          const next = { ...r }
          if (s) next[id] = s; else delete next[id]
          return next
        })
      },
    }))
    return () => { alive = false; topics.forEach(t => t.release()) }
  }, [key])
  return radar
}
