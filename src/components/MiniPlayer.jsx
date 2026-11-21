import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Undo2, Volume2, VolumeX, X } from 'lucide-react'
import { pref } from './SharePanel.jsx'
import { desktop } from '../lib/env.js'
import './mini.css'

// Miniplayer de uma transmissao.
// - Desktop: janela propria do Electron (window.open 'visor-mini', transparente e sempre no topo; mini.cjs move e
//   redimensiona). Arrastar a transmissao para fora do app abre a janela ja como carta sob o cursor; soltar fora
//   vira player. Arrastar o player de volta para cima do app vira carta de novo, e soltar devolve a mesa (ou a mao).
// - Navegador: Document Picture-in-Picture; sem ele (Firefox/Safari), um cartao flutuante dentro do app.
export const miniDesktop = desktop && !!window.visor?.mini
const MIN_W = 280, MAX_W = 960

function prepare(win) {
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) win.document.head.append(node.cloneNode(true))
  win.document.title = 'Visor'
  win.document.body.className = 'mini-doc' + (desktop ? ' is-desktop-mini' : '')
  if (miniDesktop) for (const el of [win.document.documentElement, win.document.body]) el.style.background = 'transparent'
  return win
}

// Desktop: uma janela por vez, aberta escondida antes de precisar (quando o arrasto chega perto da borda).
let deskWin = null, opening = null
export function prepareMini() {
  if (deskWin && !deskWin.closed) return Promise.resolve(deskWin)
  return opening ??= (async () => {
    const win = window.open('about:blank', 'visor-mini', 'width=200,height=200')
    if (!win) return null
    // Espera o documento da janela nova ficar pronto (o 'load' de about:blank nao chega; medido: pronto em ~50 ms).
    const start = performance.now()
    while (!win.closed && win.document.readyState !== 'complete' && performance.now() - start < 400) await new Promise(r => setTimeout(r, 16))
    if (win.closed) return null
    deskWin = prepare(win)
    return win
  })().finally(() => { opening = null })
}
export function closeMini(win = deskWin) { if (win && !win.closed) win.close(); if (win === deskWin) deskWin = null }

// Navegador: Document PiP (precisa da ativacao do gesto: chame no pointerup que soltou a transmissao).
export async function openMiniWindow(ratio = 16 / 9) {
  const width = 420, height = Math.round(width / ratio)
  if (!window.documentPictureInPicture) return null
  return prepare(await window.documentPictureInPicture.requestWindow({ width, height }))
}

// Tamanho do player (a largura fica entre aberturas; a roda do mouse ajusta).
export function miniPlayerSize(ratio = 16 / 9) {
  const w = Math.max(MIN_W, Math.min(MAX_W, pref.get('visor.miniWidth', 420)))
  return { w, h: Math.round(w / ratio) }
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

// mode: 'card' (sendo arrastada, do tamanho de uma carta da mao) ou 'player'.
// cardSize/ratio: tamanhos da janela; onMode: pede a troca de modo; onGhost({x,y} | null): cursor sobre o app
// (coordenadas da pagina principal) enquanto arrasta como carta; onDropInside({x,y}): soltou sobre o app.
export default function MiniPlayer({ win, stream, name, local, mode = 'player', ratio = 16 / 9, cardSize, onMode, onGhost, onDropInside, onBack, onClose }) {
  const video = useRef(null)
  const card = useRef(null)
  const [muted, setMuted] = useState(false)
  const volume = pref.get('visor.volumeBoost', 1.5)
  // Sem som enquanto e carta (arrastando): o audio comeca quando vira player.
  const hasAudio = useStreamAudio(local || mode === 'card' ? null : stream, volume, muted)
  const desk = miniDesktop && !!win

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
      win.visorClose = setTimeout(() => closeMini(win), 0)
    }
  }, [win])

  // Desktop: arrastar o player move a janela (o processo principal segue o cursor). Sobre o app, vira carta;
  // soltar ali devolve a transmissao. Fora do app, solta onde estiver (grudando nas bordas da tela).
  const props = useRef({})
  props.current = { mode, ratio, cardSize, onMode, onGhost, onDropInside }
  function deskDrag(e) {
    if (e.button !== 0 || e.target.closest('button')) return
    const el = card.current, r = el.getBoundingClientRect()
    const grab = { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height }
    const x0 = e.screenX, y0 = e.screenY
    let moved = false, inside = false, last = null
    el.setPointerCapture(e.pointerId)
    const mini = window.visor.mini
    const off = mini.onCursor(c => {
      if (!moved) return
      last = c
      const p = props.current
      if (c.inside !== inside) {
        inside = c.inside
        p.onMode?.(inside ? 'card' : 'player')
        mini.follow(inside ? { fx: .5, fy: .5, ...p.cardSize } : { ...grab, ...miniPlayerSize(p.ratio) })
      }
      p.onGhost?.(inside ? c : null)
    })
    const move = ev => {
      if (moved || Math.hypot(ev.screenX - x0, ev.screenY - y0) < 4) return
      moved = true
      mini.follow(grab)
    }
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up)
      off()
      if (!moved) return
      mini.unfollow()
      if (inside && last) props.current.onDropInside?.(last)
      else props.current.onGhost?.(null)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  // Roda do mouse no player: muda o tamanho (o canto perto da borda da tela fica parado).
  function wheel(e) {
    if (!desk || mode !== 'player') return
    const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(miniPlayerSize(ratio).w * (e.deltaY < 0 ? 1.08 : 1 / 1.08))))
    pref.set('visor.miniWidth', w)
    window.visor.mini.resize({ w, h: Math.round(w / ratio), anchor: 'corner' })
  }

  // Sem Document PiP: arrasta o cartao pela tela (a posicao fica entre aberturas).
  const [pos, setPos] = useState(() => pref.get('visor.miniPos', null))
  function floatDrag(e) {
    if (e.button !== 0 || e.target.closest('button')) return
    const node = card.current, r = node.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top
    node.setPointerCapture(e.pointerId)
    const move = ev => {
      const x = Math.max(8, Math.min(innerWidth - r.width - 8, ev.clientX - dx)), y = Math.max(8, Math.min(innerHeight - r.height - 8, ev.clientY - dy))
      node.style.left = x + 'px'; node.style.top = y + 'px'; node.style.right = 'auto'; node.style.bottom = 'auto'
    }
    const up = () => {
      node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up)
      const p = { left: parseFloat(node.style.left), top: parseFloat(node.style.top) }
      if (!Number.isNaN(p.left)) { setPos(p); pref.set('visor.miniPos', p) }
    }
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', up)
  }

  const label = local ? 'você' : name
  const view = <div ref={card} className={'mini ' + (win ? 'is-window' : 'is-floating') + ' is-' + mode}
    onPointerDown={desk ? deskDrag : win ? undefined : floatDrag} onWheel={wheel} onDoubleClick={e => { if (!e.target.closest('button')) onBack() }}
    style={!win && pos ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' } : undefined}>
    <video ref={video} autoPlay playsInline muted />
    <span className="mini-caption"><i className={'live-dot' + (local ? ' is-local' : '')}/><span>{label}</span></span>
    <div className="mini-hud">
      <span className="mini-chip"><i className={'live-dot' + (local ? ' is-local' : '')}/>{label}</span>
      <span className="mini-spacer"/>
      {hasAudio && <button className="mini-btn" aria-label={muted ? 'Ativar som' : 'Mudo'} data-tip={muted ? 'Ativar som' : 'Mudo'} onClick={() => setMuted(m => !m)}>
        {muted ? <VolumeX size={15} strokeWidth={1.75}/> : <Volume2 size={15} strokeWidth={1.75}/>}</button>}
      <button className="mini-btn" aria-label="Voltar para a mesa" data-tip="Voltar para a mesa" onClick={onBack}><Undo2 size={15} strokeWidth={1.75}/></button>
      <button className="mini-btn" aria-label={local ? 'Fechar' : 'Parar de ver'} data-tip={local ? 'Fechar' : 'Parar de ver'} onClick={onClose}><X size={15} strokeWidth={1.75}/></button>
    </div>
  </div>
  return createPortal(view, win ? win.document.body : document.body)
}
