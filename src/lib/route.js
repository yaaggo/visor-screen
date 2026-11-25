import { useEffect, useState } from 'react'

// Rotas por hash:
//   #/s/<serverId>/<channelId>   servidor / sala
//   #/j/<convite>/<channelId>/<perfil>   link da sala: entra no servidor pelo codigo de convite, abre a sala e
//                                        assiste a transmissao de quem mandou o link
//   #/clips                      clipes (desktop)
function parse() {
  const [, kind, a, b, c] = location.hash.replace(/^#/, '').split('/')
  if (kind === 's') return { serverId: a || null, channelId: b || null }
  if (kind === 'j' && a) return { serverId: null, channelId: null, join: { code: decodeURIComponent(a), channelId: b || null, from: c || null } }
  return { serverId: null, channelId: null, clips: kind === 'clips' }
}

export function useRoute() {
  const [route, setRoute] = useState(parse)
  useEffect(() => {
    const on = () => setRoute(parse())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return route
}

export function go(serverId, channelId) {
  const next = serverId ? `#/s/${serverId}${channelId ? `/${channelId}` : ''}` : '#/'
  if (location.hash !== next) location.hash = next
}

// Troca o endereco sem deixar o anterior no historico (o link do convite nao volta com "voltar").
export function replaceRoute(serverId, channelId) {
  location.replace(serverId ? `#/s/${serverId}${channelId ? `/${channelId}` : ''}` : '#/')
}

// Link da sala para mandar a alguem. No app desktop (file://) aponta para a versao web.
const WEB = 'https://visor-screen.vercel.app/'
export function roomLink(inviteCode, channelId, fromProfileId) {
  const base = location.protocol.startsWith('http') ? location.origin + location.pathname : WEB
  return `${base}#/j/${encodeURIComponent(inviteCode)}/${channelId}${fromProfileId ? `/${fromProfileId}` : ''}`
}
