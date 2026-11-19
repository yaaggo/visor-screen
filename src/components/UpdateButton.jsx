import { useEffect, useState } from 'react'
import { LoaderCircle, RotateCw } from 'lucide-react'
import { supabase } from '../lib/supabase.js'

async function credentials() {
  const {data:{session}} = await supabase.auth.getSession()
  if (!session) throw Error('Sessão encerrada')
  return {token:session.access_token,key:import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}
}

// O main baixa a atualização em segundo plano assim que encontra uma versão nova.
// O ícone só aparece com o instalador pronto; o clique instala e reabre o Visor.
export default function UpdateButton() {
  const [version,setVersion] = useState(null)
  const [installing,setInstalling] = useState(false)
  const [failed,setFailed] = useState(false)
  useEffect(()=>{
    const api=window.visor
    if (!api?.checkUpdate) return
    let alive=true, checking=false
    async function check() {
      if(checking)return
      checking=true
      try { const r=await api.checkUpdate(await credentials()); if(alive)setVersion(r?.ready ? r.version : null) }
      catch {} finally {checking=false}
    }
    check()
    const interval=setInterval(check,15*60*1000)
    window.addEventListener('online',check)
    const off=api.onUpdateReady?.(v=>{ if(alive)setVersion(v) })
    return ()=>{alive=false;clearInterval(interval);window.removeEventListener('online',check);off?.()}
  },[])
  if(!version)return null
  const label=installing ? 'Instalando atualização' : failed ? 'Tentar atualizar novamente' : 'Atualizar para '+version
  return <button className="desktop-update" data-tip={label} aria-label={label} disabled={installing} onClick={async()=>{
    setInstalling(true); setFailed(false)
    try { if(!await window.visor.installUpdate(await credentials())) { setVersion(null); setInstalling(false) } }
    catch { setFailed(true); setInstalling(false) }
  }}>{installing?<LoaderCircle size={16} className="spin"/>:<RotateCw size={16}/>}</button>
}
