import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, X } from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { applyRowEvent, createLiveRows } from '../lib/liveRows.js'
import { Avatar } from './ui.jsx'
import { play } from '../lib/sound.js'

const PAGE = 60
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export default function TextChannel({ channel, profile, compact = false }) {
  const [messages, setMessages] = useState(null)
  const [sending, setSending] = useState([])
  const [deleteErrors, setDeleteErrors] = useState([])
  const feedRef = useRef(null)
  const writes = useRef(new Map())
  const [draft, setDraft] = useState('')
  const listRef = useRef(null)
  const stick = useRef(true)

  useEffect(() => {
    const feed = createLiveRows(() => supabase.from('messages')
      .select('id, author_id, author_name, body, created_at').eq('channel_id', channel.id)
      .order('created_at', { ascending: false }).limit(PAGE), setMessages, [])
    feedRef.current = feed
    feed.load()
    const apply = event => {
      const row = event.new
      const batch = event.eventType === 'INSERT' && row.author_id === profile.id && writes.current.get(row.body)
      if (batch) {
        // The INSERT can arrive before its HTTP receipt. Match its real ID when the receipt arrives.
        batch.echoes.set(row.id, row)
        return
      }
      if (event.eventType === 'DELETE') {
        for (const pending of writes.current.values()) {
          pending.echoes.delete(event.old.id)
          pending.deleted.add(event.old.id)
        }
      }
      feed.change(rows => applyRowEvent(rows, event))
    }
    const ch = supabase
      .channel(`chat:${channel.id}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${channel.id}` }, apply)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, apply)
      .subscribe(feed.onStatus)
    return () => {
      feed.close()
      writes.current.clear()
      feedRef.current = null
      supabase.removeChannel(ch)
    }
  }, [channel.id, profile.id])

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, sending])

  const onScroll = () => {
    const el = listRef.current
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const send = async (e) => {
    e.preventDefault()
    const body = draft.trim()
    if (!body) return
    play('send')
    setDraft('')
    stick.current = true
    const feed = feedRef.current
    const batch = writes.current.get(body) ?? { pending: 0, echoes: new Map(), deleted: new Set() }
    writes.current.set(body, batch)
    batch.pending++
    const temp = { id: crypto.randomUUID(), temp: true, author_id: profile.id, author_name: profile.username, body, created_at: new Date().toISOString() }
    setSending(prev => [...prev, temp])
    const { data, error } = await supabase
      .from('messages')
      .insert({ channel_id: channel.id, author_name: profile.username, body })
      .select('id, author_id, author_name, body, created_at')
      .single()
    if (feed !== feedRef.current) return
    if (error) setSending(prev => prev.map(m => m.id === temp.id ? { ...m, failed: true } : m))
    else {
      batch.echoes.delete(data.id)
      if (!batch.deleted.has(data.id)) feed.change(rows => applyRowEvent(rows, { eventType: 'INSERT', new: data }))
      setSending(prev => prev.filter(m => m.id !== temp.id))
    }
    if (--batch.pending === 0) {
      writes.current.delete(body)
      for (const row of batch.echoes.values()) feed.change(rows => applyRowEvent(rows, { eventType: 'INSERT', new: row }))
    }
  }

  const remove = async (id) => {
    const feed = feedRef.current
    const { error } = await supabase.from('messages').delete().eq('id', id).select('id').single()
    if (feed !== feedRef.current) return
    if (error) setDeleteErrors(prev => prev.includes(id) ? prev : [...prev, id])
    else {
      setDeleteErrors(prev => prev.filter(item => item !== id))
      feed.change(rows => rows.filter(m => m.id !== id))
    }
  }

  const visible = useMemo(() => [...(messages ?? []), ...sending].sort((a, b) =>
    Date.parse(a.created_at) - Date.parse(b.created_at) || Number(a.id) - Number(b.id)), [messages, sending])
  return (
    <section className={`chat ${compact ? 'is-compact' : ''}`}>
      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        {visible.map((m, i) => {
          const prev = visible[i - 1]
          const grouped = prev && prev.author_name === m.author_name && new Date(m.created_at) - new Date(prev.created_at) < 5 * 60e3
          const mine = m.author_id === profile.id
          return (
            <article key={m.id} className={`msg ${grouped ? 'is-grouped' : ''} ${m.temp ? 'is-temp' : ''} ${m.failed ? 'is-failed' : ''}`}>
              <div className="msg-side">{!grouped && <Avatar id={m.author_id} name={m.author_name} size={compact ? 24 : 30} />}</div>
              <div className="msg-main">
                {!grouped && (
                  <header>
                    <strong>{m.author_name}</strong>
                    <time>{time(m.created_at)}</time>
                  </header>
                )}
                <p>{m.body}</p>
                {deleteErrors.includes(m.id) && <small role="status">Falha ao apagar</small>}
              </div>
              {mine && !m.temp && (
                <button type="button" className="msg-del" aria-label="Apagar" onClick={() => remove(m.id)}>
                  <X size={13} />
                </button>
              )}
            </article>
          )
        })}
      </div>
      <form className="composer" onSubmit={send}>
        <input value={draft} maxLength={1000} placeholder={compact ? 'Mensagem na call' : `#${channel.name}`} onChange={(e) => setDraft(e.target.value)} />
        <button className={`send ${draft.trim() ? 'is-ready' : ''}`} disabled={!draft.trim()} aria-label="Enviar">
          <ArrowUp size={16} strokeWidth={2} />
        </button>
      </form>
    </section>
  )
}
