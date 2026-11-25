import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase.js'
import { restoreSession } from './lib/session.js'
import Login from './components/Login.jsx'
function ShellLoadError() {
  return <div className="boot boot-retry">
    <span role="alert">Falha ao carregar o Visor</span>
    <button type="button" onClick={() => location.reload()}>Tentar de novo</button>
  </div>
}
const Shell = lazy(() => import('./components/Shell.jsx').catch(() => ({ default: ShellLoadError })))

// Mesa de teste das cartas: so no `npm run dev`, em #/mesa-teste (sem login).
const TableLab = import.meta.env.DEV ? lazy(() => import('./components/TableLab.jsx')) : null
// Deck de teste: so no `npm run dev`, em #/deck-teste (sem login).
const DeckLab = import.meta.env.DEV ? lazy(() => import('./components/DeckLab.jsx')) : null
// Pagina dos sons: #/sons (sem login, tambem na versao publicada)
const SoundLab = lazy(() => import('./components/SoundLab.jsx'))
// Clipes de teste: so no `npm run dev` no Electron, em #/clips-teste (sem login; volta para o deck de teste).
const ClipsPage = import.meta.env.DEV ? lazy(() => import('./components/ClipsPage.jsx')) : null
const page = () => location.hash === '#/sons' ? 'sons' : TableLab && location.hash === '#/mesa-teste' ? 'mesa' : DeckLab && location.hash.startsWith('#/deck-teste') ? 'deck' : ClipsPage && window.visor?.clips && location.hash === '#/clips-teste' ? 'clips' : null

export default function App() {
  const [lab, setLab] = useState(page)
  useEffect(() => {
    const on = () => setLab(page())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const [state, setState] = useState({ status: 'loading' })
  const retry = useRef(null)

  useEffect(() => {
    let active = true, signedOut = false, running = false, delay = 2000, timer
    function stop() {
      active = false
      clearTimeout(timer)
    }
    async function check() {
      if (!active || running) return
      clearTimeout(timer)
      running = true
      const result = await restoreSession(supabase)
      running = false
      if (!active) return
      if (result.status === 'retry') {
        setState(result)
        timer = setTimeout(check, delay)
        delay = Math.min(delay * 2, 30000)
        return
      }
      stop()
      if (result.status === 'invalid') {
        // Local logout clears the saved session before the SDK contacts the server.
        await supabase.auth.signOut({ scope: 'local' })
        if (!signedOut && retry.current === check) setState({ status: 'login' })
      } else setState(result)
    }
    retry.current = check
    const { data: sub } = supabase.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') { signedOut = true; stop(); setState({ status: 'login' }) }
    })
    window.addEventListener('online', check)
    check()
    return () => {
      stop()
      retry.current = null
      window.removeEventListener('online', check)
      sub.subscription.unsubscribe()
    }
  }, [])

  if (lab) return <Suspense fallback={null}>{lab === 'sons' ? <SoundLab/> : lab === 'deck' ? <DeckLab/> : lab === 'clips' ? <div style={{ position: 'fixed', inset: 0, display: 'grid' }}><ClipsPage onBack={() => { location.hash = '#/deck-teste' }}/></div> : <TableLab/>}</Suspense>
  const loading = <div className="boot"><span className="boot-dot" /></div>
  if (state.status === 'retry') return <div className="boot boot-retry">
    <span role="status">Reconectando…</span>
    <button type="button" onClick={() => retry.current?.()}>Tentar agora</button>
  </div>
  if (state.status === 'loading') return loading
  if (!state.profile) return <Login onReady={(_, profile) => setState({ status: 'ready', profile })} />
  return <Suspense fallback={loading}><Shell profile={state.profile} /></Suspense>
}
