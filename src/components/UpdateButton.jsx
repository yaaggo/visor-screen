import { useEffect, useState } from 'react'
import { Download, LoaderCircle, RotateCw } from 'lucide-react'
import { supabase } from '../lib/supabase.js'

async function credentials() {
  const {data:{session}} = await supabase.auth.getSession()
  if (!session) throw Error('Sessão encerrada')
  return {token:session.access_token,key:import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}
}
export default function UpdateButton() {
  const [version,setVersion] = useState(null)
  const [progress,setProgress] = useState(null)
  const [failed,setFailed] = useState(false)
  useEffect(()=>{
    const api=window.visor
    if (!api?.checkUpdate) return
    let alive=true, checking=false
    async function check() {
      if(checking)return
      checking=true
      try { const v=await api.checkUpdate(await credentials()); if(alive)setVersion(v) } catch {} finally {checking=false}
    }
    check()
    const interval=setInterval(check,15*60*1000)
    window.addEventListener('online',check)
    const off=api.onUpdateProgress(n=>setProgress(n))
    return ()=>{alive=false;clearInterval(interval);window.removeEventListener('online',check);off()}
  },[])
  if(!version)return null
  const label=progress!==null ? 'Baixando atualização · '+progress+'%' : failed ? 'Tentar atualizar novamente' : 'Instalar Visor '+version+' e reiniciar'
  return <button className="desktop-update" data-tip={label} title={label} aria-label={label} disabled={progress!==null} onClick={async()=>{
    setProgress(0); setFailed(false)
    try {if(!await window.visor.installUpdate(await credentials()))setVersion(null)}
    catch {setFailed(true)} finally {setProgress(null)}
  }}>{progress!==null?<LoaderCircle size={16} className="spin"/>:failed?<RotateCw size={16}/>:<Download size={16}/>}</button>
}
