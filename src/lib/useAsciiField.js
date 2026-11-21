import { useEffect, useLayoutEffect, useRef } from 'react'
import { createAsciiField } from './asciiField.js'

// Campo ASCII de fundo (tabuleiro do servidor e salas): lente do mouse dentro do canvas e onda ao tocar o fundo.
// background(target): se o elemento tocado conta como fundo (onde a onda nasce).
// paused: para o campo (ex.: transmitindo, ou a sala fora da tela).
export function useAsciiField(canvasRef, { light = false, paused = false, background } = {}) {
  const field = useRef(null)
  const isBackground = useRef(background)
  isBackground.current = background
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const root = canvas.parentElement
    const f = field.current = createAsciiField(canvas, { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, light })
    if (import.meta.env.DEV) (window.__fields ??= {})[light ? 'room' : 'board'] = f // depuracao: custo em stats
    const over = e => {
      if (e.pointerType === 'touch') return
      const r = canvas.getBoundingClientRect()
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) f.pointer(e.clientX, e.clientY)
      else f.leave()
    }
    const out = e => { if (!e.relatedTarget) f.leave() }
    const tap = e => {
      if (e.button !== 0 || !(e.target === root || e.target === canvas || isBackground.current?.(e.target))) return
      f.wave(e.clientX, e.clientY, { strength: light ? .3 : .38, width: 34, life: 950, speed: 420 })
    }
    addEventListener('pointermove', over)
    document.addEventListener('pointerout', out)
    root.addEventListener('pointerdown', tap)
    return () => { f.destroy(); field.current = null; removeEventListener('pointermove', over); document.removeEventListener('pointerout', out); root.removeEventListener('pointerdown', tap) }
  }, [light])
  useEffect(() => { field.current?.pause(paused) }, [paused])
  return field
}
