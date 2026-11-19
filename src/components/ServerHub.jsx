import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, LogIn, Plus } from 'lucide-react'

export default function ServerHub({ servers, onOpen, onSubmit }) {
  const [step, setStep] = useState('idle')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const card = useRef(null)
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
    try {
      const server = await onSubmit(step, value.trim())
      onOpen(server, card.current)
    } catch {
      setError(join ? 'Não foi possível entrar com esse código.' : 'Não foi possível criar o servidor.')
    } finally { setBusy(false) }
  }
  return <section className="server-hub" aria-label="Meus servidores">
    <div className="hub-items">
      {servers.map(s => <button className="hub-server" key={s.id} title={s.name} aria-label={s.name}
        onClick={e => onOpen(s, e.currentTarget)}>{s.name.slice(0,2)}</button>)}
      <div ref={card} className={'hub-card step-' + step} onKeyDown={e => {
        if (e.key === 'Escape' && !busy) change(step === 'choose' ? 'idle' : 'choose')
      }}>
        {step === 'idle' ? <button aria-label="Adicionar servidor" onClick={() => change('choose')}><Plus /></button>
          : step === 'choose' ? <div className="hub-choice">
            <button onClick={() => change('create')}><Plus size={16}/>Criar</button>
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
