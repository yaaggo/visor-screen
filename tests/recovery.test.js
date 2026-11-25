import test from 'node:test'
import assert from 'node:assert/strict'
import { restoreSession } from '../src/lib/session.js'
import { createIceLoader } from '../src/lib/ice.js'
import { applyRowEvent, createLiveRows } from '../src/lib/liveRows.js'

const user = { id: 'qa' }
const profile = { id: user.id, username: 'teste' }
function client({ session = { user }, sessionError, userError, profileError } = {}) {
  return {
    auth: {
      getSession: async () => ({ data: { session }, error: sessionError }),
      getUser: async () => ({ data: { user }, error: userError }),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: profileError }) }) }) }),
  }
}

test('a sessão só é invalidada com confirmação do Auth', async () => {
  for (const input of [{ sessionError: { status: 503 } }, { userError: { status: 429 } }, { profileError: { status: 503 } }])
    assert.equal((await restoreSession(client(input))).status, 'retry')
  assert.equal((await restoreSession(client({ userError: { code: 'session_not_found' } }))).status, 'invalid')
  assert.equal((await restoreSession(client({ session: null }))).status, 'login')
  assert.deepEqual(await restoreSession(client()), { status: 'ready', profile })
})

test('a carga preserva inserções, atualizações e exclusões recebidas durante o SELECT', async () => {
  let finish, visible
  const feed = createLiveRows(() => new Promise(resolve => { finish = resolve }), rows => { visible = rows })
  const loading = feed.load()
  const insert = { eventType: 'INSERT', new: { id: 2, name: 'mesa' } }
  feed.change(rows => applyRowEvent(rows, insert))
  feed.change(rows => applyRowEvent(rows, { eventType: 'UPDATE', new: { id: 2, name: 'nova' } }))
  feed.change(rows => applyRowEvent(rows, { eventType: 'DELETE', old: { id: 1 } }))
  finish({ data: [{ id: 1 }, insert.new] })
  await loading
  assert.deepEqual(visible, [{ id: 2, name: 'nova' }])
  feed.close()
})

test('uma resposta atrasada da assinatura anterior não sobrescreve a mais recente', async () => {
  const pending = []
  let visible
  const feed = createLiveRows(() => new Promise(resolve => pending.push(resolve)), rows => { visible = rows })
  const first = feed.load(), second = feed.load()
  pending[1]({ data: [{ id: 2 }] })
  await second
  pending[0]({ data: [] })
  await first
  assert.deepEqual(visible, [{ id: 2 }])
  const last = feed.load()
  feed.close()
  pending[2]({ data: [] })
  await last
  assert.deepEqual(visible, [{ id: 2 }])
})

test('ICE recupera de STUN, compartilha consultas e renova antes do vencimento', async t => {
  let now = 1000, calls = 0, credential
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (!credential) throw new Error('offline')
    return Response.json({ iceServers: [{ urls: 'turn:localhost', credential }], ttl: 100 })
  })
  const load = createIceLoader('/api/turn')
  await Promise.all([load(), load()])
  assert.equal(calls, 1)
  credential = 'first'
  assert.match((await load())[0].urls[0], /^stun:/)
  now += 5000
  assert.equal((await load())[0].credential, 'first')
  now += 90001
  credential = null
  assert.equal((await load())[0].credential, 'first')
  now += 10000
  assert.match((await load())[0].urls[0], /^stun:/)
  credential = 'renewed'
  now += 5000
  assert.equal((await load())[0].credential, 'renewed')
})

test('uma resposta STUN válida é usada até a próxima busca de TURN', async t => {
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const stun = [{ urls: 'stun:local.test' }]
  const turn = [{ urls: ['turns:local.test'], username: 'qa', credential: 'first' }]
  let iceServers = stun
  t.mock.method(globalThis, 'fetch', async () => Response.json({ iceServers }))
  const load = createIceLoader('/api/turn')
  assert.deepEqual(await load(), stun)
  iceServers = turn
  now += 5000
  assert.deepEqual(await load(), turn)
  iceServers = [{ ...turn[0], credential: 'new' }]
  now += 60000
  assert.deepEqual(await load(), iceServers)
})
