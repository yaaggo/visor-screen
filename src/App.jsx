import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase.js'
import Login from './components/Login.jsx'
import Shell from './components/Shell.jsx'

export default function App() {
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

  if (state.loading) return <div className="boot"><span className="boot-dot" /></div>
  if (!state.profile) return <Login session={state.session} onReady={(session, profile) => setState({ loading: false, session, profile })} />
  return <Shell profile={state.profile} />
}
