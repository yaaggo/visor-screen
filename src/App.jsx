import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase.js'
import Login from './components/Login.jsx'
import Shell from './components/Shell.jsx'
import { lazy, Suspense } from 'react'

// Mesa de teste das cartas: so no `npm run dev`, em #/mesa-teste (sem login).
const TableLab = import.meta.env.DEV ? lazy(() => import('./components/TableLab.jsx')) : null
// Deck de teste: so no `npm run dev`, em #/deck-teste (sem login).
const DeckLab = import.meta.env.DEV ? lazy(() => import('./components/DeckLab.jsx')) : null
// Pagina dos sons: #/sons (sem login, tambem na versao publicada)
const SoundLab = lazy(() => import('./components/SoundLab.jsx'))
const page = () => location.hash === '#/sons' ? 'sons' : TableLab && location.hash === '#/mesa-teste' ? 'mesa' : DeckLab && location.hash === '#/deck-teste' ? 'deck' : null

export default function App() {
  const [lab, setLab] = useState(page)
  useEffect(() => {
    const on = () => setLab(page())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const [state, setState] = useState({ loading: true, session: null, profile: null })

  const loadProfile = async (session) => {
    if (!session) return setState({ loading: false, session: null, profile: null })
    const { error } = await supabase.auth.getUser()
    if (error) {
      await supabase.auth.signOut({ scope: 'local' })
      return setState({ loading: false, session: null, profile: null })
    }
    const { data } = await supabase.from('profiles').select('id, username').eq('id', session.user.id).maybeSingle()
    setState({ loading: false, session, profile: data })
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => loadProfile(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') setState({ loading: false, session: null, profile: null })
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  if (lab) return <Suspense fallback={null}>{lab === 'sons' ? <SoundLab/> : lab === 'deck' ? <DeckLab/> : <TableLab/>}</Suspense>
  if (state.loading) return <div className="boot"><span className="boot-dot" /></div>
  if (!state.profile) return <Login onReady={(session, profile) => setState({ loading: false, session, profile })} />
  return <Shell profile={state.profile} />
}
