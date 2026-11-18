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


// Republish the latest state after a failed acknowledgement or a suspended tab.
export function presencePublisher(publish) {
  let active = true
  let revision = 0
  let retry
  async function refresh() {
    if (!active) return
    clearTimeout(retry)
    const current = ++revision
    let status
    try { status = await publish() } catch { status = 'error' }
    if (active && current === revision && (status === 'error' || status === 'timed out')) {
      retry = setTimeout(refresh, 3000)
    }
  }
  const visible = () => { if (document.visibilityState === 'visible') refresh() }
  document.addEventListener('visibilitychange', visible)
  window.addEventListener('online', refresh)
  window.addEventListener('pageshow', refresh)
  return { refresh, close() {
    active = false
    clearTimeout(retry)
    document.removeEventListener('visibilitychange', visible)
    window.removeEventListener('online', refresh)
    window.removeEventListener('pageshow', refresh)
  } }
}
