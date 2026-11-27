import { useEffect, useRef } from 'react'

// A top-layer popover also works inside fullscreen and clipped, animated panels.
export default function Tooltips() {
  const ref = useRef(null)
  useEffect(() => {
    const tip = ref.current
    let anchor, timer, touched = false
    // Depois de um toque o botao recebe foco: sem isso o tooltip abria e ficava preso no celular.
    const pointer = e => { touched = e.pointerType !== 'mouse'; hide() }
    const hide = () => {
      clearTimeout(timer)
      tip.hidePopover?.()
      tip.hidden = true
      anchor = null
    }
    const show = e => {
      const next = e.target.closest?.('[data-tip]')
      if (next === anchor) return
      hide()
      if (!next?.dataset.tip || e.pointerType === 'touch' || e.pointerType === 'pen' || (e.type === 'focusin' && touched)) return
      anchor = next
      timer = setTimeout(() => {
        if (!next.isConnected) return hide()
        tip.textContent = next.dataset.tip
        tip.hidden = false
        tip.showPopover?.()
        const r = next.getBoundingClientRect()
        const {width,height} = tip.getBoundingClientRect()
        const below = next.closest('.share-panel') && !next.closest('.bitrate-row')
        const right = next.closest('.rail')
        const x = right ? r.right + 8 : r.left + (r.width-width)/2
        const y = right ? r.top + (r.height-height)/2 : below || r.top < height + 12 ? r.bottom + 8 : r.top-height-8
        tip.style.left = Math.max(6,Math.min(innerWidth-width-6,x))+'px'
        tip.style.top = Math.max(6,Math.min(innerHeight-height-6,y))+'px'
      }, e.type === 'focusin' ? 0 : 250)
    }
    const leave = e => { if (anchor && !anchor.contains(e.relatedTarget)) hide() }
    const events = {pointerover:show,focusin:show,pointerout:leave,focusout:leave,pointerdown:pointer,keydown:e => { touched = false; hide() },scroll:hide}
    for (const [type,fn] of Object.entries(events)) document.addEventListener(type,fn,true)
    window.addEventListener('resize',hide)
    return () => {
      hide()
      for (const [type,fn] of Object.entries(events)) document.removeEventListener(type,fn,true)
      window.removeEventListener('resize',hide)
    }
  }, [])
  return <div ref={ref} role="tooltip" popover="manual" hidden className="global-tip"/>
}
