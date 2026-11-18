// Teste de upload contra a Vercel Function /api/speed (regiao gru1).
// A Vercel limita o corpo a 4,5 MB por requisicao neste plano: usamos varios envios
// paralelos de 4 MB (como os testes de velocidade comuns) para saturar o link.
import { API_BASE } from './env.js'

const CHUNK = 4_000_000
const payload = new Uint8Array(CHUNK)
crypto.getRandomValues(payload.subarray(0, 65536))

const post = (body, signal) =>
  fetch(`${API_BASE}/api/speed`, { method: 'POST', body, signal, cache: 'no-store', headers: { 'Content-Type': 'application/octet-stream' } }).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  })

async function round(parallel, rtt, signal) {
  const t0 = performance.now()
  await Promise.all(Array.from({ length: parallel }, () => post(payload, signal)))
  const ms = Math.max(performance.now() - t0 - rtt, 1)
  return (parallel * CHUNK * 8) / (ms / 1000)
}

// Retorna upload estimado em bps.
// RTT medido com conexao ja aquecida (a 1a requisicao inclui TLS/cold start e inflaria o resultado).
export async function measureUpload(signal) {
  const tiny = new Uint8Array(1024)
  const rtts = []
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    await post(tiny, signal)
    rtts.push(performance.now() - t)
  }
  const rtt = Math.min(...rtts.slice(1))
  let bps = await round(4, rtt, signal)
  // link muito rapido: rodada maior para nao subestimar
  if (bps > 150e6) bps = Math.max(bps, await round(8, rtt, signal))
  return bps
}
