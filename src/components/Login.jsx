import { useState } from 'react'
import { ArrowRight, Check, LoaderCircle } from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { Scramble } from './ui.jsx'

const VALID = /^[a-zA-Z0-9_.-]{2,20}$/

export default function Login({ session, onReady }) {
  const [name, setName] = useState('')
  const [phase, setPhase] = useState('idle') // idle | busy | done | error
  const [error, setError] = useState('')
  const valid = VALID.test(name)

  const submit = async (e) => {
    e.preventDefault()
    if (!valid || phase === 'busy') return
    setPhase('busy')
    setError('')
    const fresh = async () => {
      const { data, error: err } = await supabase.auth.signInAnonymously()
      return err ? null : data.session
    }
    const claim = (s) => supabase.from('profiles').insert({ id: s.user.id, username: name }).select('id, username').single()

    let current = session ?? (await fresh())
    if (!current) return fail('Tente de novo')
    let { data: profile, error: err } = await claim(current)
    if (err && err.code !== '23505') {
      // sessao salva invalida (usuario removido): descarta e cria outra
      await supabase.auth.signOut({ scope: 'local' })
      current = await fresh()
      if (!current) return fail('Tente de novo')
      ;({ data: profile, error: err } = await claim(current))
    }
    if (err) return fail(err.code === '23505' ? 'Em uso' : 'Tente de novo')
    setPhase('done')
    setTimeout(() => onReady(current, profile), 520)
  }

  const fail = (msg) => {
    setError(msg)
    setPhase('error')
    setTimeout(() => setPhase('idle'), 500)
  }

  return (
    <main className="login">
      <form className={`login-card phase-${phase}`} onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <Scramble text="visor" className="brand-name" />
        </div>
        <label className={`field ${name ? 'has-value' : ''} ${error ? 'has-error' : ''}`}>
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
          />
          <span className="field-count" aria-hidden>{name.length ? `${name.length}/20` : ''}</span>
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
