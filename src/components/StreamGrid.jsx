import { useLayoutEffect, useRef } from 'react'

// Choose the arrangement with the largest contained 16:9 video for this stage.
export default function StreamGrid({count, children}) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    const layout = () => {
      const {width,height} = el.getBoundingClientRect()
      if (!width || !height) return
      let best = 0, columns = 1
      for (let n=1; n<=count; n++) {
        const rows = Math.ceil(count/n)
        const w = (width-8*(n-1))/n
        const h = (height-8*(rows-1))/rows
        const size = Math.min(w,h*16/9)
        if (size>best) { best=size; columns=n }
      }
      // On a phone, keep videos readable and let the gallery scroll vertically.
      if (best < 200) columns = Math.min(count,Math.max(1,Math.floor((width+8)/208)))
      el.style.setProperty('--columns',columns)
      el.style.setProperty('--rows',Math.ceil(count/columns))
    }
    layout()
    const observer = new ResizeObserver(layout)
    observer.observe(el)
    return () => observer.disconnect()
  },[count])
  return <div ref={ref} className="stream-grid">{children}</div>
}
