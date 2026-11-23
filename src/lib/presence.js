import { desktop } from './env.js'

// Each open app or tab is a distinct signaling endpoint, even on the same account.
export const endpointId = crypto.randomUUID()

export function detectDeviceKind(env = {
  isDesktop: desktop,
  userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  platform: typeof navigator !== 'undefined' ? navigator.platform : '',
  maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0,
  coarse: typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)').matches : false,
}) {
  if (env.isDesktop) return 'desktop'
  if (/Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle|PlayBook/i.test(env.userAgent)) return 'mobile'
  if (env.platform === 'MacIntel' && env.maxTouchPoints > 1) return 'mobile'
  if (env.coarse && env.maxTouchPoints > 1) return 'mobile'
  return 'desktop'
}

export const deviceKind = detectDeviceKind()


// Publica a presenca sem estourar o limite do Supabase Realtime. Um cliente que manda
// atualizacoes rapido demais tem o canal FECHADO pelo servidor (ClientPresenceRateLimitReached).
// - agrupa rajadas (varios refresh seguidos viram um track)
// - ignora estado identico ao ultimo confirmado, enquanto a propria presenca estiver no canal
// - no maximo MAX_TRACKS em qualquer janela de WINDOW_MS; o excedente espera a janela liberar
// - repete apos falha e confere a cada 10 s se a propria presenca sumiu
// Limite do servidor (supabase/realtime, CLIENT_PRESENCE_MAX_CALLS/WINDOW_MS): 5 eventos (track e untrack,
// mesmo repetidos) a cada 30 s POR CANAL; o 6o fecha o canal. Ficamos em 4 para ter folga.
const WINDOW_MS = 30000
const MAX_TRACKS = 4
const GROUP_MS = 250

export function presencePublisher(publish, { snapshot = () => null, present = () => true } = {}) {
  let active = true
  let timer = null
  let running = false
  let pending = false
  let confirmed
  let sent = []
  function schedule(delay = GROUP_MS) {
    if (!active) return
    clearTimeout(timer)
    timer = setTimeout(run, delay)
  }
  async function run() {
    if (!active) return
    if (running) { pending = true; return }
    const state = snapshot()
    if (state !== null && state === confirmed && present() !== false) return
    const now = Date.now()
    sent = sent.filter(t => now - t < WINDOW_MS)
    if (sent.length >= MAX_TRACKS) { schedule(WINDOW_MS - (now - sent[0]) + 100); return }
    running = true
    sent.push(now)
    let status
    try { status = await publish() } catch { status = 'error' }
    running = false
    if (!active) return
    if (status === 'ok') confirmed = state
    if (pending) { pending = false; schedule() }
    else if (typeof status === 'string' && status !== 'ok') schedule(3000)
  }
  const refresh = () => { confirmed = undefined; schedule() }
  // Voltar para a aba/rede so publica se o estado mudou ou a propria presenca sumiu (run confere os dois).
  // Antes forcava um track a cada alt-tab, e alternar entre o jogo e o Visor estourava o limite.
  const check = () => schedule()
  const visible = () => { if (document.visibilityState === 'visible') check() }
  const heal = setInterval(() => { if (present() === false) refresh() }, 10000)
  document.addEventListener('visibilitychange', visible)
  window.addEventListener('online', check)
  window.addEventListener('pageshow', check)
  return {
    refresh: () => schedule(),
    // Depois de reabrir o canal o servidor nao tem mais o estado: forca o envio.
    reset: refresh,
    close() {
      active = false
      clearTimeout(timer)
      clearInterval(heal)
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('online', check)
      window.removeEventListener('pageshow', check)
    },
  }
}
