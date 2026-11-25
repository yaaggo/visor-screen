import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../../src/App.jsx'
import TextChannel from '../../src/components/TextChannel.jsx'
import { supabase } from '../../src/lib/supabase.js'
import '../../src/styles.css'

const mode = new URLSearchParams(location.search).get('mode')
const profile = { id: 'qa', username: 'qa' }
const qa = window.qa = { callbacks: {}, logouts: [], authCalls: 0, hold: true, deletes: 0, sends: [] }
const message = (id, body) => ({ id, body, author_name: 'qa', author_id: 'qa', created_at: new Date(1000 * id).toISOString() })
qa.insert = (id, body) => qa.callbacks.INSERT({ eventType: 'INSERT', new: message(id, body) })
supabase.channel = () => ({
  on(_type, filter, fn) { qa.callbacks[filter.event] = fn; return this },
  subscribe() { return this },
})
supabase.removeChannel = () => {}
supabase.auth.getSession = async () => ({ data: { session: { user: profile } } })
supabase.auth.getUser = async () => {
  qa.authCalls++
  if (mode === 'revoked') return { error: { code: 'session_not_found' } }
  return qa.authCalls === 1 || qa.hold ? { error: { status: 503 } } : { data: { user: profile } }
}
supabase.auth.signOut = async options => { qa.logouts.push(options.scope); return { error: null } }
supabase.from = table => {
  let deleting = false, sending
  return {
    select() { return this }, eq() { return this }, order() { return this },
    maybeSingle: async () => ({ data: profile }),
    then(ok, fail) { return Promise.resolve({ data: [] }).then(ok, fail) },
    limit: () => new Promise(resolve => { qa.history = () => resolve({ data: [message(1, 'histórico')] }) }),
    delete() { deleting = true; return this },
    insert(row) { sending = row.body; return this },
    single: async () => {
      if (deleting) return ++qa.deletes === 1 ? { error: { status: 503 } } : { data: { id: 1 } }
      if (sending) return new Promise(resolve => { qa.sends.push(id => resolve({ data: message(id, sending) })) })
      throw Error('Unexpected read of ' + table)
    },
  }
}
const root = createRoot(document.getElementById('root'))
root.render(<StrictMode>{mode === 'chat'
  ? <TextChannel channel={{ id: 'local', name: 'sala' }} profile={profile}/>
  : <App/>}</StrictMode>)
