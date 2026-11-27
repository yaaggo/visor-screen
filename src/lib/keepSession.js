// O supabase-js so renova o token com a pagina visivel: ao esconder a aba (ou minimizar o app
// para jogar) ele para o temporizador. Depois de 1 h o token vencia e Realtime/broadcast davam 401
// ate a pessoa voltar. Aqui, enquanto a pagina esta oculta, getSession() roda a cada 30 s e renova
// quando faltam menos de 90 s para vencer. Abas ocultas ha mais de 5 min tem temporizadores limitados
// a 1 por minuto, o que ainda cai dentro dessa margem. Visivel, o proprio supabase-js volta a cuidar.
export const KEEP_ALIVE_MS = 30_000

export function keepSessionWhileHidden(client, doc = globalThis.document, timers = globalThis) {
  if (!doc?.addEventListener) return () => {}
  let timer = null
  const tick = () => { client.auth.getSession().catch(() => {}) }
  const sync = () => {
    if (timer) timers.clearInterval(timer)
    timer = null
    if (doc.visibilityState === 'hidden') timer = timers.setInterval(tick, KEEP_ALIVE_MS)
  }
  doc.addEventListener('visibilitychange', sync)
  sync()
  return () => {
    doc.removeEventListener('visibilitychange', sync)
    if (timer) timers.clearInterval(timer)
    timer = null
  }
}
