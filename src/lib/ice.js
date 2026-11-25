const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }]
const RETRY_MS = 5000

export function createIceLoader(url) {
  let servers = STUN
  let expiresAt = 0
  let refreshAt = 0
  let pending

  async function refresh() {
    const start = Date.now()
    let fallback = STUN
    try {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
      if (!response.ok) throw new Error('ICE unavailable')
      const { iceServers, ttl } = await response.json()
      const valid = Array.isArray(iceServers) ? iceServers.filter(server =>
        [server?.urls].flat().some(address => /^(stun|turn)s?:/i.test(address))) : []
      const hasTurn = valid.some(server => [server.urls].flat().some(address => /^turns?:/i.test(address)))
      if (hasTurn) {
        // Older endpoints issue 24-hour credentials but omit ttl. Recheck them within a minute.
        const lifetime = Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 60000
        servers = valid
        expiresAt = start + lifetime
        refreshAt = expiresAt - Math.min(60000, lifetime / 10)
        return servers
      }
      if (valid.length) fallback = valid
    } catch { /* A new peer can still connect directly. */ }
    const now = Date.now()
    if (now >= expiresAt) servers = fallback
    refreshAt = now < expiresAt ? Math.min(expiresAt, now + RETRY_MS) : now + RETRY_MS
    return servers
  }

  return () => {
    if (Date.now() < refreshAt) return Promise.resolve(servers)
    pending ??= refresh().finally(() => { pending = null })
    return pending
  }
}
