import test from 'node:test'
import assert from 'node:assert/strict'
import { keepSessionWhileHidden, KEEP_ALIVE_MS } from '../src/lib/keepSession.js'

function setup(state = 'visible') {
  const listeners = new Set()
  const doc = {
    visibilityState: state,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
  }
  const intervals = new Map()
  let next = 1
  const timers = {
    setInterval: (fn, ms) => { intervals.set(next, { fn, ms }); return next++ },
    clearInterval: (id) => intervals.delete(id),
  }
  let calls = 0
  const client = { auth: { getSession: async () => { calls++; return { data: {} } } } }
  const set = (s) => { doc.visibilityState = s; listeners.forEach(fn => fn()) }
  const fire = () => intervals.forEach(i => i.fn())
  return { doc, timers, client, set, fire, intervals, listeners, calls: () => calls }
}

test('visivel: nao cria temporizador (o supabase-js cuida)', () => {
  const t = setup('visible')
  keepSessionWhileHidden(t.client, t.doc, t.timers)
  assert.equal(t.intervals.size, 0)
})

test('oculta: chama getSession a cada 30 s; volta visivel: para', () => {
  const t = setup('visible')
  keepSessionWhileHidden(t.client, t.doc, t.timers)
  t.set('hidden')
  assert.equal(t.intervals.size, 1)
  assert.equal([...t.intervals.values()][0].ms, KEEP_ALIVE_MS)
  t.fire(); t.fire()
  assert.equal(t.calls(), 2)
  t.set('visible')
  assert.equal(t.intervals.size, 0)
})

test('iniciar ja oculta e trocar varias vezes nao acumula temporizadores', () => {
  const t = setup('hidden')
  const stop = keepSessionWhileHidden(t.client, t.doc, t.timers)
  t.set('hidden'); t.set('hidden')
  assert.equal(t.intervals.size, 1)
  stop()
  assert.equal(t.intervals.size, 0)
  assert.equal(t.listeners.size, 0)
})

test('falha do getSession nao vira excecao solta', async () => {
  const t = setup('hidden')
  t.client.auth.getSession = () => Promise.reject(new Error('offline'))
  keepSessionWhileHidden(t.client, t.doc, t.timers)
  t.fire()
  await new Promise(r => setTimeout(r, 0))
})

test('sem document (Node): nao faz nada', () => {
  const stop = keepSessionWhileHidden({ auth: {} }, undefined)
  stop()
})
