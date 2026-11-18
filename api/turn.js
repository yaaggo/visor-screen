// Vercel Function: devolve iceServers. Com CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN
// gera credenciais TURN de curta duracao; sem elas, devolve so STUN.
const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }]

export async function GET() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }

  if (!keyId || !token) return new Response(JSON.stringify({ iceServers: STUN }), { headers })

  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    })
    if (!r.ok) throw new Error(String(r.status))
    const data = await r.json()
    const turn = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers]
    return new Response(JSON.stringify({ iceServers: [...STUN, ...turn] }), { headers })
  } catch {
    return new Response(JSON.stringify({ iceServers: STUN }), { headers })
  }
}
