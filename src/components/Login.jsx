import { useRef, useState } from 'react'
import { ArrowRight, Check, Link2, LoaderCircle } from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { Scramble } from './ui.jsx'
import { useRoute } from '../lib/route.js'
import { authenticate, cleanName, MESSAGES, NAME, nameHint } from '../lib/login.js'

const PIN_MAX = 4

export default function Login({ onReady }) {
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  // Veio por um link de sala: depois de entrar (ou criar a conta) o app abre a sala sozinho.
  const { join: invite } = useRoute()
  const [phase, setPhase] = useState('idle') // idle | busy | done | error
  const [error, setError] = useState('')
  const pinRef = useRef(null)
  // Trava sincrona: Enter + clique no mesmo instante criavam duas tentativas (a segunda via "conta ja existe").
  const busy = useRef(false)
  const valid = NAME.test(name) && pin.length >= 1
  const hint = nameHint(name, pin.length > 0)

  const fail = (reason) => {
    setError(MESSAGES[reason] || MESSAGES.retry)
    setPhase('error')
    setTimeout(() => setPhase('idle'), 500)
    if (reason === 'taken') { setPin(''); pinRef.current?.focus() }
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!valid || busy.current) return
    busy.current = true
    setPhase('busy')
    setError('')
    await supabase.auth.signOut({ scope: 'local' })
    const result = await authenticate(supabase, name, pin)
    if (result.status !== 'ok') {
      busy.current = false
      return fail(result.reason)
    }
    setPhase('done')
    setTimeout(() => onReady(result.session, result.profile), 520)
  }

  return (
    <main className="login">
      <form className={`login-card phase-${phase}`} onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <Scramble text="visor" className="brand-name" />
          {invite && <span className="login-invite" data-tip="Link de sala" aria-label="Link de sala"><Link2 size={13} strokeWidth={2}/>sala</span>}
        </div>
        <label className={`field login-name ${name ? 'has-value' : ''} ${error || hint ? 'has-error' : ''}`}>
          <span className="field-label" aria-live="polite">{error || hint || 'usuario'}</span>
          <input
            autoFocus
            value={name}
            maxLength={20}
            spellCheck={false}
            autoComplete="username"
            onChange={(e) => {
              setName(cleanName(e.target.value))
              setError('')
            }}
            onKeyDown={(e) => e.key === 'Enter' && !pin && (e.preventDefault(), pinRef.current?.focus())}
          />
          <span className="field-count" aria-hidden>{name.length ? `${name.length}/20` : ''}</span>
        </label>

        {/* Senha curta em caixas (conceito "OTP code") */}
        <label className={`pin ${error ? 'has-error' : ''}`} aria-label="Senha">
          <input
            ref={pinRef}
            className="pin-input"
            type="password"
            value={pin}
            maxLength={PIN_MAX}
            autoComplete="current-password"
            onChange={(e) => {
              setPin(e.target.value.replace(/\s/g, '').slice(0, PIN_MAX))
              setError('')
            }}
          />
          {Array.from({ length: PIN_MAX }, (_, i) => (
            <span key={i} className={`pin-cell ${i < pin.length ? 'is-filled' : ''} ${i === pin.length ? 'is-caret' : ''}`}>
              <span className="pin-dot" />
            </span>
          ))}
        </label>

        <button className={`go-btn ${valid ? 'is-ready' : ''}`} disabled={!valid} aria-label="Entrar">
          <span className="go-icon" data-show={phase === 'idle' || phase === 'error'}><ArrowRight size={18} /></span>
          <span className="go-icon spin" data-show={phase === 'busy'}><LoaderCircle size={18} /></span>
          <span className="go-icon" data-show={phase === 'done'}><Check size={18} /></span>
        </button>
      </form>
    </main>
  )
}
