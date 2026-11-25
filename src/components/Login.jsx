import { useRef, useState } from 'react'
import { ArrowRight, Check, Link2, LoaderCircle } from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { Scramble } from './ui.jsx'
import { useRoute } from '../lib/route.js'

const VALID = /^[a-zA-Z0-9_.-]{2,20}$/
const PIN_MAX = 4

// Conta = e-mail sintetico (nunca recebe e-mail; confirmacao desligada) + senha derivada do PIN.
// O prefixo existe porque o Supabase exige senha de 6+ caracteres; o segredo real e o PIN (1-4 caracteres).
const emailFor = (name) => `${name.toLowerCase()}@visor-screen.vercel.app`
const passwordFor = (pin) => `visor-pin:${pin}`

export default function Login({ onReady }) {
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  // Veio por um link de sala: depois de entrar (ou criar a conta) o app abre a sala sozinho.
  const { join: invite } = useRoute()
  const [phase, setPhase] = useState('idle') // idle | busy | done | error
  const [error, setError] = useState('')
  const pinRef = useRef(null)
  const valid = VALID.test(name) && pin.length >= 1

  const fail = (msg) => {
    setError(msg)
    setPhase('error')
    setTimeout(() => setPhase('idle'), 500)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!valid || phase === 'busy') return
    setPhase('busy')
    setError('')
    await supabase.auth.signOut({ scope: 'local' })

    const email = emailFor(name)
    const password = passwordFor(pin)
    let { data, error: err } = await supabase.auth.signInWithPassword({ email, password })

    if (err) {
      // nao entrou: nome novo (cria a conta) ou PIN errado (nome ja existe)
      const up = await supabase.auth.signUp({ email, password })
      if (up.error) {
        const taken = up.error.code === 'user_already_exists' || /already/i.test(up.error.message)
        return fail(taken ? 'Senha incorreta' : 'Tente de novo')
      }
      data = up.data
      if (!data.session) return fail('Tente de novo')
    }

    const session = data.session
    let { data: profile } = await supabase.from('profiles').select('id, username').eq('id', session.user.id).maybeSingle()
    if (!profile) {
      const ins = await supabase.from('profiles').insert({ id: session.user.id, username: name }).select('id, username').single()
      if (ins.error) return fail(ins.error.code === '23505' ? 'Em uso' : 'Tente de novo')
      profile = ins.data
    }
    setPhase('done')
    setTimeout(() => onReady(session, profile), 520)
  }

  return (
    <main className="login">
      <form className={`login-card phase-${phase}`} onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <Scramble text="visor" className="brand-name" />
          {invite && <span className="login-invite" data-tip="Link de sala" aria-label="Link de sala"><Link2 size={13} strokeWidth={2}/>sala</span>}
        </div>
        <label className={`field login-name ${name ? 'has-value' : ''} ${error ? 'has-error' : ''}`}>
          <span className="field-label">{error || 'usuario'}</span>
          <input
            autoFocus
            value={name}
            maxLength={20}
            spellCheck={false}
            autoComplete="username"
            onChange={(e) => {
              setName(e.target.value.replace(/\s/g, ''))
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
