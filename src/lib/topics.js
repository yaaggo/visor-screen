import { supabase } from './supabase.js'
import { endpointId } from './presence.js'

// Canais de presenca 'calls:<servidor>' compartilhados. O realtime-js devolve o MESMO canal para o mesmo topico:
// se uma parte do app fecha o topico enquanto outra o abre, a nova recebe um canal saindo e nunca entra.
// Aqui ha um canal por topico, com varios usuarios (diretorio da call, tabuleiro, radar do deck):
// - o canal so fecha 1,5 s depois do ultimo usuario sair (trocar de tela reaproveita o canal vivo);
// - fechado pelo servidor (ex.: limite de presenca), reabre em 3 s e avisa 'SUBSCRIBED' de novo;
// - quem entra com o canal ja assinado recebe 'SUBSCRIBED' e o estado atual logo em seguida.
// Quem publica presenca (track) precisa fazer untrack ao sair: o canal pode continuar aberto para os outros.
const topics = new Map()
if (import.meta.env.DEV) window.__topics = topics

function open(topic, t) {
  t.wait = 0
  if (!t.users.size || topics.get(topic) !== t) return
  // Um canal anterior deste topico ainda saindo: espera ele sumir antes de criar outro.
  if (supabase.getChannels().some(c => c.topic === 'realtime:' + topic)) { t.wait = setTimeout(() => open(topic, t), 250); return }
  const ch = supabase.channel(topic, { config: { private: true, presence: { key: endpointId, enabled: true } } })
  t.ch = ch; t.status = null
  ch.on('presence', { event: 'sync' }, () => {
    if (t.ch !== ch) return
    const state = ch.presenceState()
    for (const user of t.users) user.onSync?.(state)
  }).subscribe(status => {
    if (t.ch !== ch) return
    t.status = status
    for (const user of t.users) user.onStatus?.(status)
    if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      t.ch = null; t.status = null
      supabase.removeChannel(ch)
      t.wait = setTimeout(() => open(topic, t), 3000)
    }
  })
}

function close(topic, t) {
  if (t.users.size || topics.get(topic) !== t) return
  topics.delete(topic)
  clearTimeout(t.wait)
  const ch = t.ch
  t.ch = null
  if (ch) supabase.removeChannel(ch)
}

export function acquireTopic(topic, { onSync, onStatus } = {}) {
  let t = topics.get(topic)
  if (!t) { t = { users: new Set(), ch: null, status: null, timer: 0, wait: 0 }; topics.set(topic, t) }
  clearTimeout(t.timer)
  const user = { onSync, onStatus }
  t.users.add(user)
  if (!t.ch && !t.wait) open(topic, t)
  else if (t.status === 'SUBSCRIBED') queueMicrotask(() => {
    if (!t.users.has(user) || t.status !== 'SUBSCRIBED') return
    onStatus?.('SUBSCRIBED')
    onSync?.(t.ch.presenceState())
  })
  return {
    get channel() { return t.ch },
    release() {
      if (!t.users.delete(user)) return
      if (!t.users.size) t.timer = setTimeout(() => close(topic, t), 1500)
    },
  }
}

// Lista plana da presenca: uma entrada por meta, com a chave (instancia) em `id`.
export const presenceList = state => Object.entries(state).flatMap(([id, metas]) => metas.map(meta => ({ ...meta, id })))
