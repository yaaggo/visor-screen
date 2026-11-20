import { useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Layers, LogIn, LogOut, Plus, Trash2, UserRound, X } from 'lucide-react'
import { ServerFace, usePopover } from './ui.jsx'
import './deck.css'
import { play } from '../lib/sound.js'
import SoundToggle from './SoundToggle.jsx'

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
const serversPerPage = 3

function Face({server}) {
  return <>
    <span className="deck-art">{server ? <ServerFace server={server}/> : <Plus size={36} strokeWidth={1.4}/>}</span>
    <span className="deck-caption">{server?.name ?? 'Adicionar servidor'}</span>
  </>
}

export default function ServerHub({ servers, ownerId, onDelete, returningId, onOpen, onSubmit, editProfile, logout }) {
  const account = usePopover()
  const [page, setPage] = useState(() => Math.max(0, Math.floor(servers.findIndex(s => s.id === returningId)/serversPerPage)))
  const [step,setStep] = useState('idle')
  const [draw,setDraw] = useState(null)
  const [selected,setSelected] = useState(null)
  const [value,setValue] = useState('')
  const [error,setError] = useState('')
  const [busy,setBusy] = useState(false)
  const center = useRef(null)
  const trash = useRef(null)
  const gesture = useRef(null)
  const timer = useRef(null)
  const held = useRef(false)
  const skipClick = useRef(false)
  const form = useRef(null)
  const deck = draw?.servers ?? servers
  const lastPage = Math.max(0, Math.ceil(deck.length / serversPerPage) - 1)
  const activePage = Math.min(page,lastPage)
  const cards = [...deck.slice(activePage * serversPerPage, (activePage + 1) * serversPerPage), null]
  function clearGesture() {
    const g = gesture.current
    if (g) {
      clearTimeout(g.trashTimer)
      g.detach?.()
      g.copy?.remove()
      g.node.style.opacity = ''
      gesture.current = null
    }
    trash.current?.classList.remove('visible','arming')
    center.current?.classList.remove('target','near')
  }
  useLayoutEffect(() => () => { clearTimeout(timer.current); clearGesture() }, [])
  useLayoutEffect(() => {
    if (step === 'choose') form.current?.querySelector('button:not(.deck-close)')?.focus()
    if (step === 'join' || step === 'create') form.current?.querySelector('input')?.focus()
    if (step === 'arrived') {
      play('wave')
      // A onda vive no body: comeca no impacto da carta e termina por cima da transicao para o tabuleiro.
      if (!reduced() && center.current) {
        const r = center.current.getBoundingClientRect()
        const wave = document.createElement('div')
        wave.className = 'deck-wave is-global'
        wave.style.setProperty('--cx', r.left + r.width / 2 + 'px')
        wave.style.setProperty('--cy', r.top + r.height / 2 + 'px')
        document.body.append(wave)
        setTimeout(() => wave.remove(), 1100)
      }
      timer.current = setTimeout(() => {
        if (center.current) onOpen(selected,center.current)
      },reduced() ? 0 : 470)
      return () => clearTimeout(timer.current)
    }
  },[step,selected,onOpen])

  function copyCard(node,rect) {
    play('lift')
    const copy = document.createElement('div')
    const face = node.cloneNode(true)
    face.removeAttribute('data-server')
    face.classList.add('deck-facsimile')
    const style = getComputedStyle(node)
    Object.assign(face.style,{width:node.offsetWidth+'px',height:node.offsetHeight+'px',rotate:style.rotate,scale:style.scale})
    copy.className = 'deck-copy'
    copy.append(face)
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
      if (accept) {
        // Place the same face in the center before removing its moving copy.
        flushSync(() => {
          setDraw({ id:server?.id ?? null, servers })
          setSelected(server)
          setStep(server ? 'arrived' : 'choose')
        })
      } else { held.current = false; play('back') }
      clearGesture()
    }
  }
  function begin(e,server) {
    if (held.current || !e.isPrimary || e.button !== 0) return
    skipClick.current = false
    const node = e.currentTarget
    setError('')
    if (server && server.owner_id===ownerId) trash.current.classList.add('visible')
    gesture.current = {node,server,rect:node.getBoundingClientRect(),x:e.clientX,y:e.clientY,pointer:e.pointerId}
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
    if (g.server && g.server.owner_id===ownerId) {
      const bin = trash.current.getBoundingClientRect()
      const inside = e.clientX>=bin.left && e.clientX<=bin.right && e.clientY>=bin.top && e.clientY<=bin.bottom
      if (inside && !g.trashTimer) {
        trash.current.classList.add('arming')
        g.copy?.classList.add('arming')
        g.trashTimer = setTimeout(()=>discard(g),1500)
      } else if (!inside && g.trashTimer) {
        clearTimeout(g.trashTimer)
        g.trashTimer = null
        trash.current.classList.remove('arming')
        g.copy?.classList.remove('arming')
      }
      if (inside) g.near=false
    }
    center.current.classList.add('target')
    center.current.classList.toggle('near',g.near)
  }
  async function discard(g) {
    if (gesture.current!==g || held.current) return
    held.current=true
    skipClick.current=true
    g.detach()
    const bin=trash.current.getBoundingClientRect()
    const rect=g.copy.getBoundingClientRect()
    const dx=bin.x+bin.width/2-rect.x-rect.width/2
    const dy=bin.y+bin.height/2-rect.y-rect.height/2
    Object.assign(g.copy.style,{left:rect.left+'px',top:rect.top+'px',transform:'none'})
    const folding=g.copy.animate([
      {transform:'perspective(400px) rotateX(0deg)',clipPath:'inset(0)'},
      {transform:'perspective(400px) rotateX(44deg) rotateZ(-12deg) scale(.68)',clipPath:'polygon(0 0,100% 0,72% 100%,27% 82%)',offset:.45},
      {transform:`translate(${dx}px,${dy}px) rotate(35deg) scale(.06)`,opacity:0}
    ],{duration:reduced()?1:400,fill:'forwards'})
    play('crumple')
    try { await folding.finished; if (gesture.current===g) await onDelete(g.server) }
    catch { if(gesture.current===g)setError('Não foi possível apagar o servidor.') }
    finally { if(gesture.current===g){clearGesture();held.current=false} }
  }
  function release(e,server,cancelled=false) {
    const g=gesture.current
    if (!g || held.current || g.pointer!==e.pointerId) return
    if (!cancelled) move(e)
    if (!g.moved) { clearGesture(); return }
    skipClick.current=true
    clearTimeout(g.trashTimer)
    trash.current.classList.remove('visible','arming')
    g.detach?.()
    fly(server,g.node,!cancelled && g.near)
  }
  function reset() {
    setStep('returning')
  }
  useLayoutEffect(() => {
    if (step !== 'returning') return
    const panel = center.current
    const destination = panel.parentElement.querySelector('.deck-hand .deck-add')
    const returnCard = async () => {
      // Let the selector close into its original card shape before moving it.
      await Promise.allSettled(panel.getAnimations().map(a => a.finished))
      if (cancelled) return
      const from = panel.getBoundingClientRect()
      const to = destination.getBoundingClientRect()
      const dx = to.x + to.width/2 - from.x - from.width/2
      const dy = to.y + to.height/2 - from.y - from.height/2
      flight = panel.animate([{ transform:'none' }, { transform:`translate(${dx}px,${dy}px) rotate(${getComputedStyle(destination).rotate})` }],
        {duration:reduced()?1:340,easing:'cubic-bezier(.22,.8,.18,1)',fill:'forwards'})
      flight.onfinish = () => {
        held.current = false
        flushSync(() => {setDraw(null);setSelected(null);setStep('idle');setError('');setValue('')})
        destination.focus({preventScroll:true})
      }
    }
    let cancelled = false, flight
    returnCard()
    return () => { cancelled=true; flight?.cancel() }
  },[step])

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
      {account.open && <div className="hub-account-menu"><button onClick={()=>{account.setOpen(false);editProfile()}}><UserRound size={15}/>Perfil</button><SoundToggle size={15}/><button onClick={logout}><LogOut size={15}/>Sair</button></div>}
    </div></header>
    <div ref={center} className={'deck-center step-'+step}>
      {step==='idle' ? <Layers size={24} aria-hidden/> : step==='arrived' || step==='returning' ? <Face server={selected}/> :
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
        className={'deck-card'+(server?'':' deck-add')} data-drawn={draw && draw.id===(server?.id ?? null) ? true : undefined} style={{'--d':i-(cards.length-1)/2,'--abs':Math.abs(i-(cards.length-1)/2),'--z':server ? i+1 : 0}}
        onPointerDown={e=>begin(e,server)}
        onLostPointerCapture={e=>release(e,server,true)} onClick={e=>{
          if(skipClick.current && e.detail!==0){skipClick.current=false;return}
          if(!held.current)fly(server,e.currentTarget,true)
        }}><Face server={server}/></button>)}
    </div>
    <div ref={trash} className="deck-trash" aria-label="Segure por 1,5 segundo para apagar"><Trash2 size={21}/></div>
    {step==='idle' && error && <small className="deck-notice" role="alert">{error}</small>}
    <footer className="deck-footer"><Layers size={15}/> Deck
      {lastPage>0 && <><button disabled={activePage===0 || held.current} aria-label="Cartas anteriores" onClick={()=>setPage(activePage-1)}><ChevronLeft size={16}/></button>
        <button disabled={activePage===lastPage || held.current} aria-label="Próximas cartas" onClick={()=>setPage(activePage+1)}><ChevronRight size={16}/></button></>}
    </footer>
  </section>
}
