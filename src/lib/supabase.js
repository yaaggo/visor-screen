import { createClient } from '@supabase/supabase-js'
import { keepSessionWhileHidden } from './keepSession.js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 40 } },
})

keepSessionWhileHidden(supabase)
