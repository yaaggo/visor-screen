import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Undo2, Volume2, VolumeX, X } from 'lucide-react'
import { pref } from './SharePanel.jsx'
import { play } from '../lib/sound.js'
import { desktop } from '../lib/env.js'
import './mini.css'

// Janela do miniplayer, sempre no topo e com o CSS do app:
// - desktop: janela propria do Electron (window.open 'visor-mini', sem moldura; o Electron nao abre Document PiP);
// - navegador: Document Picture-in-Picture (precisa da ativacao do gesto: chame no pointerup que soltou a transmissao);
// - sem nenhum dos dois (Firefox/Safari): null, e o miniplayer flutua dentro do app.
function prepare(win) {
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) win.document.head.append(node.cloneNode(true))
  win.document.title = 'Visor'
  win.document.body.className = 'mini-doc' + (desktop ? ' is-desktop-mini' : '')
  return win
}
export async function openMiniWindow(ratio = 16 / 9) {
  const width = 420, height = Math.round(width / ratio)
  if (desktop) {
    const win = window.open('about:blank', 'visor-mini', `width=${width},height=${height}`)
    if (!win) return null
    // O Electron cria a janela e carrega about:blank nela, trocando o documento inicial: espera essa carga
    // antes de desenhar (senao o conteudo some e o pagehide do documento inicial fecharia o miniplayer).
    await new Promise(done => { win.addEventListener('load', done, { once: true }); setTimeout(done, 1500) })
    return win.closed ? null : prepare(win)
  }
  if (!window.documentPictureInPicture) return null
  return prepare(await window.documentPictureInPicture.requestWindow({ width, height }))
}

// Som da transmissao no miniplayer: o mesmo amplificador do palco (ganho ate 300% + limitador), na janela principal.
function useStreamAudio(stream, volume, muted) {
  const booster = useRef(null)
  useEffect(() => {
    const [track] = stream?.getAudioTracks() ?? []
    if (!track || typeof AudioContext === 'undefined') return
    let ctx
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' })
      const source = ctx.createMediaStreamSource(new MediaStream([track]))
      const gain = ctx.createGain()
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -1; limiter.knee.value = 6; limiter.ratio.value = 12; limiter.attack.value = .002; limiter.release.value = .12
      source.connect(gain); gain.connect(limiter); limiter.connect(ctx.destination)
      booster.current = { ctx, gain }
    } catch { booster.current = null }
    return () => { booster.current = null; ctx?.close().catch(() => {}) }
  }, [stream])
  useEffect(() => {
    const b = booster.current
    if (!b) return
    b.gain.gain.setTargetAtTime(muted ? 0 : volume, b.ctx.currentTime, .015)
    if (!muted && b.ctx.state === 'suspended') b.ctx.resume().catch(() => {})
  }, [stream, volume, muted])
  return !!stream?.getAudioTracks().length
}

// Miniplayer de uma transmissao: video, nome e tres acoes (som, voltar para a mesa, parar de ver).
// win = janela do Document PiP; sem ela, um cartao flutuante arrastavel dentro do app.
export default function MiniPlayer({ win, stream, name, local, onBack, onClose }) {
  const video = useRef(null)
  const card = useRef(null)
  const [muted, setMuted] = useState(false)
  const volume = pref.get('visor.volumeBoost', 1.5)
  const hasAudio = useStreamAudio(local ? null : stream, volume, muted)

  useEffect(() => {
    const v = video.current
    if (!v) return
    if (v.srcObject !== stream) v.srcObject = stream ?? null
    v.play().catch(() => {})
  }, [stream])

  // Fechar a janela pelo sistema = voltar para a mesa. Desmontar fecha a janela.
  const back = useRef(onBack)
  back.current = onBack
  useEffect(() => {
    if (!win) return
    // Fecha um tique depois: no modo dev o React desmonta e remonta o efeito na hora (StrictMode).
    clearTimeout(win.visorClose)
    const closed = () => back.current()
    win.addEventListener('pagehide', closed)
    return () => {
      win.removeEventListener('pagehide', closed)
      win.visorClose = setTimeout(() => { if (!win.closed) win.close() }, 0)
    }
  }, [win])
  useEffect(() => { play('open') }, [])

  // Sem Document PiP: arrasta o cartao pela tela (a posicao fica entre aberturas).
  const [pos, setPos] = useState(() => pref.get('visor.miniPos', null))
  function drag(e) {
    if (win || e.button !== 0 || e.target.closest('button')) return
    const node = card.current, r = node.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top
    node.setPointerCapture(e.pointerId)
    const move = ev => {
      const x = Math.max(8, Math.min(innerWidth - r.width - 8, ev.clientX - dx)), y = Math.max(8, Math.min(innerHeight - r.height - 8, ev.clientY - dy))
      node.style.left = x + 'px'; node.style.top = y + 'px'; node.style.right = 'auto'; node.style.bottom = 'auto'
    }
    const up = ev => {
      node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up)
      const p = { left: parseFloat(node.style.left), top: parseFloat(node.style.top) }
      if (!Number.isNaN(p.left)) { setPos(p); pref.set('visor.miniPos', p) }
    }
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', up)
  }

  const view = <div ref={card} className={'mini ' + (win ? 'is-window' : 'is-floating')} onPointerDown={drag}
    style={!win && pos ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' } : undefined}>
    <video ref={video} autoPlay playsInline muted />
    <div className="mini-hud">
      <span className="mini-chip"><i className={'live-dot' + (local ? ' is-local' : '')}/>{local ? 'você' : name}</span>
      <span className="mini-spacer"/>
      {hasAudio && <button className="mini-btn" aria-label={muted ? 'Ativar som' : 'Mudo'} data-tip={muted ? 'Ativar som' : 'Mudo'} onClick={() => setMuted(m => !m)}>
        {muted ? <VolumeX size={15} strokeWidth={1.75}/> : <Volume2 size={15} strokeWidth={1.75}/>}</button>}
      <button className="mini-btn" aria-label="Voltar para a mesa" data-tip="Voltar para a mesa" onClick={onBack}><Undo2 size={15} strokeWidth={1.75}/></button>
      <button className="mini-btn" aria-label={local ? 'Fechar' : 'Parar de ver'} data-tip={local ? 'Fechar' : 'Parar de ver'} onClick={onClose}><X size={15} strokeWidth={1.75}/></button>
    </div>
  </div>
  return createPortal(view, win ? win.document.body : document.body)
}
