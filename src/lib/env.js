// Ambiente: desktop (Electron, window.visor) ou navegador.
export const desktop = typeof window !== 'undefined' && !!window.visor?.desktop
export const API_BASE = location.protocol === 'file:' ? 'https://visor-screen.vercel.app' : ''
if (desktop) document.documentElement.classList.add('is-desktop')
