// Tela cheia que funciona em cada plataforma:
// - Desktop, Android e iPad: o palco inteiro (video + controles) vai para tela cheia. No celular, a
//   orientacao trava em paisagem quando o video e mais largo que alto.
// - iPhone: o Safari nao deixa elementos comuns entrarem em tela cheia, so o proprio <video>
//   (player nativo, com rotacao). O som continua saindo pelo amplificador.
const doc = typeof document === 'undefined' ? null : document

export const fullscreenElement = () => doc?.fullscreenElement || doc?.webkitFullscreenElement || null

const elementFullscreen = (el) =>
  !!(el?.requestFullscreen || el?.webkitRequestFullscreen) && (doc?.fullscreenEnabled ?? doc?.webkitFullscreenEnabled ?? true) !== false

const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

function lockLandscape(video) {
  const o = typeof screen !== 'undefined' ? screen.orientation : null
  if (!o?.lock || !coarse() || !video || video.videoWidth < video.videoHeight) return
  o.lock('landscape').catch(() => {})
}

function unlockOrientation() {
  try { screen.orientation?.unlock?.() } catch { /* sem trava */ }
}

// 'element' | 'video' | null (nada funcionou)
export async function enterFullscreen(el, video) {
  if (elementFullscreen(el)) {
    try {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' })
      else await el.webkitRequestFullscreen()
      lockLandscape(video)
      return 'element'
    } catch { /* tenta o video */ }
  }
  if (video?.webkitEnterFullscreen) {
    try {
      video.webkitEnterFullscreen()
      return 'video'
    } catch { /* video sem metadados ainda */ }
  }
  if (video?.requestFullscreen) {
    try {
      await video.requestFullscreen()
      lockLandscape(video)
      return 'element'
    } catch { /* sem suporte */ }
  }
  return null
}

export async function exitFullscreen(video) {
  unlockOrientation()
  try {
    if (fullscreenElement()) await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())
    else if (video?.webkitDisplayingFullscreen) video.webkitExitFullscreen?.()
  } catch { /* ja saiu */ }
}

// Chama onChange(true/false) quando o elemento (ou o video no iPhone) entra/sai da tela cheia.
export function watchFullscreen(el, video, onChange) {
  const sync = () => {
    const on = fullscreenElement() === el || fullscreenElement() === video || !!video?.webkitDisplayingFullscreen
    if (!on) unlockOrientation()
    onChange(on)
  }
  const docEvents = ['fullscreenchange', 'webkitfullscreenchange']
  const videoEvents = ['webkitbeginfullscreen', 'webkitendfullscreen']
  docEvents.forEach(t => doc?.addEventListener(t, sync))
  videoEvents.forEach(t => video?.addEventListener(t, sync))
  return () => {
    docEvents.forEach(t => doc?.removeEventListener(t, sync))
    videoEvents.forEach(t => video?.removeEventListener(t, sync))
  }
}
