import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, LogIn, LogOut, Plus, UserRound } from 'lucide-react'

import { usePopover } from './ui.jsx'

export default function ServerHub({ servers, onOpen, onSubmit, editProfile, logout }) {
  const [step, setStep] = useState('idle')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [snapshot, setSnapshot] = useState(null)
  const [added, setAdded] = useState(null)
  const items = useRef(null)
  const account = usePopover()
  const open = useRef(onOpen)
  open.current = onOpen
  useEffect(() => {
    if (!added) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (step === 'settling') {
      const timer = setTimeout(() => { setSnapshot(null); setStep('idle') }, reduced ? 0 : 480)
      return () => clearTimeout(timer)
    }
    const timer = setTimeout(() => {
      const tile = items.current?.querySelector(`[data-server="${added.id}"]`)
      if (tile) open.current(added, tile)
    }, reduced ? 0 : 880)
    return () => clearTimeout(timer)
  }, [added, step])
  const input = useRef(null)
  const join = step === 'join'
  function change(next) {
    setValue('')
    setError('')
    setStep(next)
  }
  useEffect(() => { input.current?.focus() }, [step])
  async function submit(e) {
    e.preventDefault()
    if (busy || !value.trim()) return
    setBusy(true)
    setSnapshot(servers)
    try {
      const server = await onSubmit(step, value.trim())
      setAdded(server)
      change('settling')
    } catch {
      setError(join ? 'Não foi possível entrar com esse código.' : 'Não foi possível criar o servidor.')
      setSnapshot(null)
      setBusy(false)
    }
  }
  return <section className="server-hub" aria-label="Meus servidores" onPointerDown={e => {
    if (!busy && !e.target.closest('.hub-card') && step !== 'idle') change('idle')
  }}>
    <header className="hub-titlebar">
      <div ref={account.ref} className="hub-account">
        <button className="hub-brand" aria-label="Menu da conta" aria-expanded={account.open}
          onClick={() => account.setOpen(!account.open)}><i className="brand-mark" aria-hidden/>Visor</button>
        {account.open && <div className="hub-account-menu">
          <button onClick={() => { account.setOpen(false); editProfile() }}><UserRound size={15}/>Perfil</button>
          <button onClick={logout}><LogOut size={15}/>Sair</button>
        </div>}
      </div>
    </header>
    <div className={'hub-items' + (added && step === 'idle' ? ' revealing' : '')} ref={items}>
      {(snapshot ?? servers).map(s => <button disabled={busy} data-server={s.id} className="hub-server" key={s.id} title={s.name} aria-label={s.name}
        onClick={e => onOpen(s, e.currentTarget)}>{s.name.slice(0,2)}</button>)}
      <div key={added && step === 'idle' ? 'revealed-add' : 'add'} className={'hub-card step-' + step} onKeyDown={e => {
        if (e.key === 'Escape' && !busy) change(step === 'choose' ? 'idle' : 'choose')
      }}>
        {step === 'settling' ? <span className="hub-initials">{added.name.slice(0,2)}</span> : step === 'idle' ? <button disabled={busy} aria-label="Adicionar servidor" onClick={() => change('choose')}><Plus size={30} strokeWidth={1.7}/></button>
          : step === 'choose' ? <div className="hub-choice">
            <button autoFocus onClick={() => change('create')}><Plus size={16}/>Criar</button>
            <button onClick={() => change('join')}><LogIn size={16}/>Entrar</button>
          </div> : <form onSubmit={submit}>
            <button type="button" disabled={busy} aria-label="Voltar" onClick={() => change('choose')}><ArrowLeft size={16}/></button>
            <label className={join ? 'hub-code' : 'hub-name'}>
              {join && <span aria-hidden="true">{Array.from({length:10},(_,i) => <i key={i}>{value[i] || '·'}</i>)}</span>}
              <input ref={input} aria-label={join ? 'Código do servidor' : 'Nome do servidor'} placeholder={join ? '' : 'Nome do servidor'}
                autoComplete="off" disabled={busy} maxLength={join ? 10 : 32} value={value}
                onChange={e => { setValue(join ? e.target.value.toUpperCase().replace(/[^0-9A-F]/g,'') : e.target.value); setError('') }}/>
            </label>
            <button className="hub-confirm" disabled={busy || (join ? value.length !== 10 : !value.trim())} aria-label="Confirmar"><ArrowRight size={18}/></button>
          </form>}
        {error && <small role="alert">{error}</small>}
      </div>
    </div>
  </section>
}
