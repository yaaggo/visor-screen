import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, X } from 'lucide-react'
import { supabase } from '../lib/supabase.js'

const size = 256
const clamp = (v, max) => Math.min(max, Math.max(0, v))

// Sample a unit-mass spring into a CSS timing function using the File drop coefficients.
function spring(stiffness, damping) {
  let x = 0, velocity = 0
  const points = [0]
  for (let i = 0; i < 180; i++) {
    velocity += (stiffness * (1 - x) - damping * velocity) / 240
    x += velocity / 240
    if (i % 4 === 3) points.push(x.toFixed(4))
  }
  return 'linear(' + points.join(',') + ')'
}
const motion = { '--zone-ease': spring(380, 16), '--core-ease': spring(420, 14), '--line-ease': spring(360, 30) }

async function uploadPhoto(id, blob, onProgress) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw Error('Sessão encerrada')
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', import.meta.env.VITE_SUPABASE_URL + '/storage/v1/object/avatars/' + id + '.webp')
    xhr.setRequestHeader('apikey', import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY)
    xhr.setRequestHeader('Authorization', 'Bearer ' + session.access_token)
    xhr.setRequestHeader('Content-Type', blob.type)
    xhr.setRequestHeader('cache-control', 'max-age=60')
    xhr.setRequestHeader('x-upsert', 'true')
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round(e.loaded * 100 / e.total)) }
    xhr.timeout = 30000
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(Error('Upload recusado'))
    xhr.onerror = xhr.ontimeout = () => reject(Error('Falha de conexão'))
    xhr.send(blob)
  })
}

export default function ProfilePhoto({ profile, server, saved, close }) {
  const title = server ? 'Foto do servidor' : 'Foto de perfil'
  const dialog = useRef(null), picker = useRef(null), canvas = useRef(null), drag = useRef(null)
  const [image, setImage] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [center, setCenter] = useState([0.5, 0.5])
  const [progress, setProgress] = useState(0)
  const [near, setNear] = useState(false)
  const [phase, setPhase] = useState('pick')
  const [error, setError] = useState('')
  const ticket = useRef(0)
  useEffect(() => {
    dialog.current.showModal()
    return () => { ticket.current++ }
  }, [])
  useEffect(() => () => image?.close(), [image])
  const edge = image && Math.min(image.width, image.height) / zoom
  const left = image && center[0] * (image.width - edge)
  const top = image && center[1] * (image.height - edge)
  useEffect(() => {
    if (!image || !canvas.current) return
    const ctx = canvas.current.getContext('2d')
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(image, left, top, edge, edge, 0, 0, size, size)
  }, [image, edge, left, top])
  async function choose(file) {
    if (!file) return
    const current = ++ticket.current
    setNear(false)
    setError('')
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 12 * 1024 ** 2) {
      setError('Escolha JPG, PNG ou WebP de até 12 MB.')
      return
    }
    try {
      const bitmap = await createImageBitmap(file)
      if (ticket.current !== current) return bitmap.close()
      setImage(bitmap)
      setCenter([0.5, 0.5])
      setZoom(1)
      setPhase('crop')
    } catch { setError('Não foi possível abrir a imagem.') }
  }
  async function save() {
    setError('')
    setPhase('saving')
    try {
      const blob = await new Promise(resolve => canvas.current.toBlob(resolve, 'image/webp', .78))
      if (blob?.type !== 'image/webp' || blob.size > 65536) throw Error()
      setProgress(0)
      await uploadPhoto(server ? 'servers/' + server.id : profile.id, blob, setProgress)
      const revision = Date.now()
      if (server) {
        const {error} = await supabase.from('servers').update({photo_revision:revision}).eq('id',server.id).select('id').single()
        if (error) throw error
      }
      saved(revision)
      setPhase('done')
    } catch { setPhase('crop'); setError('Falha ao salvar. Tente novamente.') }
  }
  return <dialog ref={dialog} className={'photo-dialog' + (server ? ' server-crop' : '')} style={motion} onCancel={e => { if (phase === 'saving') e.preventDefault() }} onClose={close} aria-label={title}>
    <header><strong>{title}</strong><button aria-label="Fechar" disabled={phase === 'saving'} onClick={close}><X size={18}/></button></header>
    <input ref={picker} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={e => { choose(e.target.files[0]); e.target.value = '' }}/>
    {phase === 'pick' ? <button className={'photo-drop' + (near ? ' near' : '')} onClick={() => picker.current.click()}
      onDragOver={e => { e.preventDefault(); setNear(true) }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setNear(false) }}
      onDrop={e => { e.preventDefault(); choose(e.dataTransfer.files[0]) }}>
      <i><ArrowUp/></i><strong>{near ? 'Solte sua foto' : 'Escolher ou soltar foto'}</strong><small>JPG, PNG ou WebP · até 12 MB</small>
    </button> : <>
      <canvas ref={canvas} width={size} height={size} aria-label="Recorte. Arraste ou use as setas." tabIndex={0}
        onKeyDown={e => {
          const d = { ArrowLeft: [-.02,0], ArrowRight: [.02,0], ArrowUp: [0,-.02], ArrowDown: [0,.02] }[e.key]
          if (d && phase === 'crop') { e.preventDefault(); setCenter(([x,y]) => [clamp(x+d[0],1),clamp(y+d[1],1)]) }
        }}
        onPointerDown={e => { if (phase === 'crop') { e.target.setPointerCapture(e.pointerId); drag.current = [e.clientX,e.clientY,left,top] } }}
        onLostPointerCapture={() => { drag.current = null }}
        onPointerMove={e => {
          if (!drag.current) return
          const [x,y,l,t] = drag.current, scale = edge / e.target.getBoundingClientRect().width
          setCenter([clamp((l+(x-e.clientX)*scale)/(image.width-edge || 1),1),clamp((t+(y-e.clientY)*scale)/(image.height-edge || 1),1)])
        }}/>
      {phase === 'crop' && <><label>Zoom<input aria-label="Zoom do recorte" type="range" min="1" max="4" step=".01" value={zoom} onChange={e => setZoom(+e.target.value)}/></label>
      <footer><button onClick={() => picker.current.click()}>Trocar</button><button onClick={save}>Salvar foto</button></footer></>}
      {phase === 'saving' && <div className="photo-status" role="status"><span className="photo-ring"><svg viewBox="0 0 48 48" aria-hidden><circle cx="24" cy="24" r="21" pathLength="100" strokeDasharray="100" strokeDashoffset={100-progress}/></svg>{progress}%</span>Salvando foto</div>}
      {phase === 'done' && <button className="photo-done" onClick={close}><Check size={18}/> Foto salva</button>}
    </>}
    {error && <p role="alert">{error}</p>}
  </dialog>
}
