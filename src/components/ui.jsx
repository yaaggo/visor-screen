import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Check, Copy } from 'lucide-react'

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// Botao magnetico: segue o ponteiro alguns pixels (conceito "Magnetic button")
export function IconButton({ label, active, className = '', children, magnetic = true, ...props }) {
  const ref = useRef(null)
  const move = (e) => {
    if (!magnetic || reduced()) return
    const r = ref.current.getBoundingClientRect()
    const x = (e.clientX - r.left - r.width / 2) * 0.18
    const y = (e.clientY - r.top - r.height / 2) * 0.18
    ref.current.style.translate = `${x}px ${y}px`
  }
  const leave = () => ref.current && (ref.current.style.translate = '0 0')
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      data-tip={label}
      className={`icon-btn ${active ? 'is-active' : ''} ${className}`}
      onPointerMove={move}
      onPointerLeave={leave}
      {...props}
    >
      {children}
    </button>
  )
}

// Controle segmentado com pilula deslizante (conceito "Tab pill" / "Segmented control")
export function Segmented({ value, onChange, options, size = 'md', label }) {
  const wrap = useRef(null)
  const [pill, setPill] = useState(null)
  useLayoutEffect(() => {
    const el = wrap.current?.querySelector(`[data-value="${CSS.escape(String(value))}"]`)
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth })
  }, [value, options.length])
  return (
    <div ref={wrap} className={`segmented seg-${size}`} role="radiogroup" aria-label={label}>
      {pill && <span className="seg-pill" style={{ translate: `${pill.left}px 0`, width: pill.width }} />}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.label}
          data-tip={o.tip}
          data-value={o.value}
          className={o.value === value ? 'is-on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.text && <span>{o.text}</span>}
        </button>
      ))}
    </div>
  )
}

// Copiar com morph de icone (conceito "Copy button")
export function CopyButton({ text, label = 'Copiar link' }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1400)
    return () => clearTimeout(t)
  }, [done])
  return (
    <IconButton
      label={done ? 'Copiado' : label}
      className={`copy-btn ${done ? 'is-done' : ''}`}
      onClick={() => navigator.clipboard.writeText(text).then(() => setDone(true))}
    >
      <span className="swap">
        <Copy size={16} strokeWidth={1.75} />
        <Check size={16} strokeWidth={2} />
      </span>
    </IconButton>
  )
}

// Segurar para confirmar (conceito "Hold to publish")
export function HoldButton({ label, onConfirm, children, ms = 900 }) {
  const [holding, setHolding] = useState(false)
  const timer = useRef(null)
  const start = () => {
    setHolding(true)
    timer.current = setTimeout(() => {
      setHolding(false)
      onConfirm()
    }, ms)
  }
  const cancel = () => {
    clearTimeout(timer.current)
    setHolding(false)
  }
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      className={`hold-btn ${holding ? 'is-holding' : ''}`}
      style={{ '--hold': `${ms}ms` }}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !holding && start()}
      onKeyUp={cancel}
    >
      <span className="hold-fill" />
      {children}
    </button>
  )
}

const photoSession = Date.now()
export function Avatar({ name = '?', size = 28, id, revision }) {
  const url = id && supabase.storage.from('avatars').getPublicUrl(encodeURIComponent(id) + '.webp').data.publicUrl + '?v=' + (Number(revision) || photoSession)
  const [failed, setFailed] = useState(null)
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
      {url && failed !== url && <img alt="" draggable={false} src={url} onError={() => setFailed(url)} />}
    </span>
  )
}

// Texto embaralhado que assenta letra a letra (conceito "Scramble text")
export function Scramble({ text, className }) {
  const [out, setOut] = useState(text)
  useEffect(() => {
    if (reduced()) return setOut(text)
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let frame = 0
    const id = setInterval(() => {
      frame++
      setOut(
        text
          .split('')
          .map((c, i) => (i < frame / 2 ? c : chars[Math.floor(Math.random() * chars.length)]))
          .join(''),
      )
      if (frame / 2 >= text.length) clearInterval(id)
    }, 32)
    return () => clearInterval(id)
  }, [text])
  return <span className={className}>{out}</span>
}

// Popover que nasce do botao de origem (conceito "Morph popover")
export function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false)
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    addEventListener('pointerdown', onDown)
    addEventListener('keydown', onKey)
    return () => {
      removeEventListener('pointerdown', onDown)
      removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, setOpen, ref }
}

// URL da foto do servidor (photo_url so existe nos labs, com imagem gerada localmente).
export const serverPhotoUrl = server => server.photo_url ?? (server.photo_revision ? supabase.storage.from('avatars')
  .getPublicUrl('servers/' + server.id + '.webp').data.publicUrl + '?v=' + server.photo_revision : null)

// Duas primeiras letras do nome sem espacos, por caractere completo (nao corta emoji ao meio).
export const serverInitials = name => Array.from(name.replace(/\s+/g, '')).slice(0, 2).join('') || '?'

export function ServerFace({server}) {
  const url = serverPhotoUrl(server)
  const [failed, setFailed] = useState(null)
  return url && url !== failed ? <img className="server-photo" alt="" draggable={false} src={url} onError={() => setFailed(url)}/>
    : serverInitials(server.name)
}
