import { useEffect, useState } from 'react'

// Rotas por hash: #/s/<serverId>/<channelId>
function parse() {
  const [, kind, serverId, channelId] = location.hash.replace(/^#/, '').split('/')
  return kind === 's' ? { serverId: serverId || null, channelId: channelId || null } : { serverId: null, channelId: null, clips: kind === 'clips' }
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

export const inviteUrl = (serverId, channelId) =>
  `${location.origin}/#/s/${serverId}${channelId ? `/${channelId}` : ''}`
