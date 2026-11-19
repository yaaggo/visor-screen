import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Layers, LogIn, LogOut, Plus, UserRound, X } from 'lucide-react'
import { ServerFace, usePopover } from './ui.jsx'
import './deck.css'

// Sample a unit-mass spring in four substeps per 60 Hz frame, as in Fan Cards.
function spring(k, damping) {
  let x = 0, velocity = 0
  const samples = [0]
  for (let frame = 0; frame < 60; frame++) {
    for (let sub = 0; sub < 4; sub++) {
      velocity += (k * (1 - x) - damping * velocity) / 240
      x += velocity / 240
    }
    samples.push(x.toFixed(4))
  }
  return 'linear(' + samples.join(',') + ')'
}
const springs = { '--fan':spring(220,18), '--lift':spring(420,20), '--scale':spring(420,22), '--settle':spring(280,22) }
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const pageSize = 4

function Face({server}) {
  return <>
    <span className="deck-art">{server ? <ServerFace server={server}/> : <Plus size={36} strokeWidth={1.4}/>}</span>
    <span className="deck-caption">{server?.name ?? 'Adicionar servidor'}</span>
  </>
}

export default function ServerHub({ servers, returningId, onOpen, onSubmit, editProfile, logout }) {
  const account = usePopover()
  const [page, setPage] = useState(() => Math.max(0, Math.floor(servers.findIndex(s => s.id === returningId)/pageSize)))
  const [step,setStep] = useState('idle')
  const [selected,setSelected] = useState(null)
  const [value,setValue] = useState('')
  const [error,setError] = useState('')
  const [busy,setBusy] = useState(false)
  const center = useRef(null)
  const gesture = useRef(null)
  const timer = useRef(null)
  const held = useRef(false)
  const skipClick = useRef(false)
  const form = useRef(null)
  const lastPage = Math.floor(servers.length/pageSize)
  const activePage = Math.min(page,lastPage)
  const cards = [...servers,null].slice(activePage*pageSize,(activePage+1)*pageSize)
  function clearGesture() {
    const g = gesture.current
    if (g) {
      g.detach?.()
      g.copy?.remove()
      g.node.style.opacity = ''
      gesture.current = null
    }
    center.current?.classList.remove('target','near')
  }
  useLayoutEffect(() => () => { clearTimeout(timer.current); clearGesture() }, [])
  useLayoutEffect(() => {
    if (step === 'choose') form.current?.querySelector('button:not(.deck-close)')?.focus()
    if (step === 'join' || step === 'create') form.current?.querySelector('input')?.focus()
    if (step === 'arrived') {
      timer.current = setTimeout(() => {
        if (center.current) onOpen(selected,center.current.querySelector('.deck-art'))
      },reduced() ? 0 : 175)
      return () => clearTimeout(timer.current)
    }
  },[step,selected,onOpen])

  function copyCard(node,rect) {
    const copy = node.cloneNode(true)
    copy.removeAttribute('data-server')
    copy.removeAttribute('id')
    copy.classList.add('deck-copy')
    copy.inert = true
    Object.assign(copy.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'})
    document.body.append(copy)
    node.style.opacity = '0'
    return copy
  }
  function fly(server,node,accept) {
    const g = gesture.current ?? {node,rect:node.getBoundingClientRect()}
    gesture.current = g
    held.current = true
    const copy = g.copy ?? copyCard(node,g.rect)
    g.copy = copy
    const from = copy.getBoundingClientRect()
    const to = (accept ? center.current : node).getBoundingClientRect()
    Object.assign(copy.style,{left:from.left+'px',top:from.top+'px',transform:'none'})
    center.current.classList.remove('target','near')
    const dx = to.left + to.width/2 - from.left - from.width/2
    const dy = to.top + to.height/2 - from.top - from.height/2
    const animation = copy.animate([{transform:'none'},{transform:`translate(${dx}px,${dy}px) scale(${to.width/from.width},${to.height/from.height})` }],
      {duration:reduced()?1: g.moved ? 280 : 230,easing:'cubic-bezier(.2,.8,.2,1)',fill:'forwards'})
    animation.onfinish = () => {
      if (gesture.current !== g) return
      clearGesture()
      if (accept) {
        setSelected(server)
        setStep(server ? 'arrived' : 'choose')
      } else held.current = false
    }
  }
  function begin(e,server) {
    if (held.current || !e.isPrimary || e.button !== 0) return
    skipClick.current = false
    const node = e.currentTarget
    gesture.current = {node,rect:node.getBoundingClientRect(),x:e.clientX,y:e.clientY,pointer:e.pointerId}
    const up = event => release(event,server)
    const cancel = event => release(event,server,true)
    const blur = () => cancel({pointerId:e.pointerId})
    window.addEventListener('pointermove',move)
    window.addEventListener('pointerup',up)
    window.addEventListener('pointercancel',cancel)
    window.addEventListener('blur',blur)
    gesture.current.detach = () => {
      window.removeEventListener('pointermove',move)
      window.removeEventListener('pointerup',up)
      window.removeEventListener('pointercancel',cancel)
      window.removeEventListener('blur',blur)
    }
    node.setPointerCapture(e.pointerId)
  }
  function move(e) {
    const g = gesture.current
    if (held.current || !g || g.pointer !== e.pointerId) return
    const dx=e.clientX-g.x, dy=e.clientY-g.y
    if (!g.moved && Math.hypot(dx,dy)<5) return
    g.moved = true
    g.copy ??= copyCard(g.node,g.rect)
    g.copy.style.transform = `translate(${dx}px,${dy}px)`
    const target = center.current.getBoundingClientRect()
    const r = g.copy.getBoundingClientRect()
    g.near = Math.abs(r.x+r.width/2-target.x-target.width/2)<target.width*.75 &&
      Math.abs(r.y+r.height/2-target.y-target.height/2)<target.height*.65
    center.current.classList.add('target')
    center.current.classList.toggle('near',g.near)
  }
  function release(e,server,cancelled=false) {
    const g=gesture.current
    if (!g || held.current || g.pointer!==e.pointerId) return
    if (!cancelled) move(e)
    if (!g.moved) { clearGesture(); return }
    skipClick.current=true
    g.detach?.()
    fly(server,g.node,!cancelled && g.near)
  }
  function reset() {
    clearGesture()
    held.current=false
    setSelected(null); setStep('idle'); setError(''); setValue('')
    requestAnimationFrame(()=>document.querySelector('.deck-add')?.focus())
  }
  async function submit(e) {
    e.preventDefault()
    if (!value.trim() || busy) return
    setBusy(true); setError('')
    try {
      const server = await onSubmit(step,value.trim())
      setSelected(server); setStep('arrived')
    } catch (err) {
      setError(err.code==='P0003' ? 'Nome repetido. Use o código de convite.' : err.code==='P0002' ? 'Servidor não encontrado.' : 'Não foi possível concluir. Tente novamente.')
    } finally { setBusy(false) }
  }
  return <section className="server-hub deck-hub" aria-label="Deck de servidores" style={springs}
    onKeyDown={e=>{if(e.key==='Escape' && !busy && ['choose','create','join'].includes(step))reset()}}>
    <header className="hub-titlebar"><div ref={account.ref} className="hub-account">
      <button className="hub-brand" aria-label="Menu da conta" aria-expanded={account.open} onClick={()=>account.setOpen(!account.open)}><i className="brand-mark" aria-hidden/>Visor</button>
      {account.open && <div className="hub-account-menu"><button onClick={()=>{account.setOpen(false);editProfile()}}><UserRound size={15}/>Perfil</button><button onClick={logout}><LogOut size={15}/>Sair</button></div>}
    </div></header>
    <div ref={center} className={'deck-center step-'+step}>
      {step==='idle' ? <Layers size={24} aria-hidden/> : step==='arrived' ? <><i className="deck-wave"/><Face server={selected}/></> :
        <div ref={form} className="deck-actions">
          <button className="deck-close" aria-label="Voltar ao deck" disabled={busy} onClick={reset}><X size={15}/></button>
          {step==='choose' ? <>{[['create','Criar servidor',Plus],['join','Entrar em servidor',LogIn]].map(([key,label,Icon])=>
            <button key={key} onClick={()=>{setStep(key);setValue('');setError('')}}><Icon size={17}/>{label}</button>)}</> :
            <form onSubmit={submit}><label>{step==='create'?'Criar servidor':'Entrar em servidor'}
              <input aria-label={step==='create'?'Nome do servidor':'Nome ou convite'} placeholder={step==='create'?'Nome do servidor':'Nome ou convite'} maxLength={32} value={value} disabled={busy} onChange={e=>setValue(e.target.value)}/></label>
              <div><button type="button" aria-label="Voltar" disabled={busy} onClick={()=>{setError('');setStep('choose')}}><ArrowLeft size={16}/></button>
              <button className="deck-confirm" aria-label="Confirmar" disabled={busy || !value.trim()}><ArrowRight size={17}/></button></div></form>}
          {error && <small role="alert">{error}</small>}
        </div>}
    </div>
    <div className="deck-hand" inert={step!=='idle'} style={{'--gaps':Math.max(1,cards.length-1)}}>
      {cards.map((server,i)=><button key={server?.id ?? 'add'} data-server={server?.id} aria-label={server?.name ?? 'Adicionar servidor'}
        className={'deck-card'+(server?'':' deck-add')} style={{'--d':i-(cards.length-1)/2,'--abs':Math.abs(i-(cards.length-1)/2),'--z':i+1}}
        onPointerDown={e=>begin(e,server)}
        onLostPointerCapture={e=>release(e,server,true)} onClick={e=>{
          if(skipClick.current && e.detail!==0){skipClick.current=false;return}
          if(!held.current)fly(server,e.currentTarget,true)
        }}><Face server={server}/></button>)}
    </div>
    <footer className="deck-footer"><Layers size={15}/> Deck
      {lastPage>0 && <><button disabled={activePage===0 || held.current} aria-label="Cartas anteriores" onClick={()=>setPage(activePage-1)}><ChevronLeft size={16}/></button>
        <button disabled={activePage===lastPage || held.current} aria-label="Próximas cartas" onClick={()=>setPage(activePage+1)}><ChevronRight size={16}/></button></>}
    </footer>
  </section>
}
