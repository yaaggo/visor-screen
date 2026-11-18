import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, X } from 'lucide-react'
import { supabase } from '../lib/supabase.js'
import { Avatar } from './ui.jsx'

const PAGE = 60
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export default function TextChannel({ channel, profile, compact = false }) {
  const [messages, setMessages] = useState(null)
  const [draft, setDraft] = useState('')
  const listRef = useRef(null)
  const stick = useRef(true)

  useEffect(() => {
    let alive = true
    supabase
      .from('messages')
      .select('id, author_id, author_name, body, created_at')
      .eq('channel_id', channel.id)
      .order('created_at', { ascending: false })
      .limit(PAGE)
      .then(({ data }) => alive && setMessages((data ?? []).reverse()))

    const ch = supabase
      .channel(`chat:${channel.id}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${channel.id}` }, (p) =>
        setMessages((prev) => {
          if (!prev) return prev
          const withoutTemp = prev.filter((m) => !(m.temp && m.author_id === p.new.author_id && m.body === p.new.body))
          return withoutTemp.some((m) => m.id === p.new.id) ? withoutTemp : [...withoutTemp, p.new]
        }),
      )
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (p) =>
        setMessages((prev) => prev && prev.filter((m) => m.id !== p.old.id)),
      )
      .subscribe()
    return () => {
      alive = false
      supabase.removeChannel(ch)
    }
  }, [channel.id])

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const onScroll = () => {
    const el = listRef.current
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const send = async (e) => {
    e.preventDefault()
    const body = draft.trim()
    if (!body) return
    setDraft('')
    stick.current = true
    const temp = { id: `t${Date.now()}`, temp: true, author_id: profile.id, author_name: profile.username, body, created_at: new Date().toISOString() }
    setMessages((prev) => [...(prev ?? []), temp])
    const { data, error } = await supabase
      .from('messages')
      .insert({ channel_id: channel.id, author_name: profile.username, body })
      .select('id, author_id, author_name, body, created_at')
      .single()
    setMessages((prev) => {
      const rest = prev.filter((m) => m.id !== temp.id)
      if (error) return [...rest, { ...temp, failed: true }]
      return rest.some((m) => m.id === data.id) ? rest : [...rest, data]
    })
  }

  const remove = async (id) => {
    setMessages((prev) => prev.filter((m) => m.id !== id))
    await supabase.from('messages').delete().eq('id', id)
  }

  return (
    <section className={`chat ${compact ? 'is-compact' : ''}`}>
      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        {messages?.map((m, i) => {
          const prev = messages[i - 1]
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
        <input value={draft} maxLength={1000} placeholder={`#${channel.name}`} onChange={(e) => setDraft(e.target.value)} />
        <button className={`send ${draft.trim() ? 'is-ready' : ''}`} disabled={!draft.trim()} aria-label="Enviar">
          <ArrowUp size={16} strokeWidth={2} />
        </button>
      </form>
    </section>
  )
}
