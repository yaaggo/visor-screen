import test from 'node:test'
import assert from 'node:assert/strict'
import { authenticate, cleanName, nameHint } from '../src/lib/login.js'

const user = { id: 'u1' }
const session = { user }
const invalid = { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' }

function client({ signIn, signUp = async () => ({ data: { session }, error: null }), profile = { id: 'u1', username: 'ana' }, insert } = {}) {
  const calls = { signUp: 0, insert: 0 }
  return {
    calls,
    auth: {
      signInWithPassword: signIn,
      signUp: async (...a) => { calls.signUp++; return signUp(...a) },
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }),
      insert: (row) => ({ select: () => ({ single: async () => { calls.insert++; return insert ? insert(row) : { data: row, error: null } } }) }),
    }),
  }
}

test('nome novo cria a conta e o perfil', async () => {
  const c = client({ signIn: async () => ({ data: {}, error: invalid }), profile: null })
  const r = await authenticate(c, 'Ana', '12')
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.profile, { id: 'u1', username: 'Ana' })
  assert.equal(c.calls.signUp, 1)
})

test('conta existente entra sem cadastrar', async () => {
  const c = client({ signIn: async () => ({ data: { session }, error: null }) })
  const r = await authenticate(c, 'ana', '12')
  assert.equal(r.status, 'ok')
  assert.equal(c.calls.signUp, 0)
})

test('nome de outra pessoa ou senha errada: taken', async () => {
  const c = client({
    signIn: async () => ({ data: {}, error: invalid }),
    signUp: async () => ({ data: {}, error: { status: 422, code: 'user_already_exists', message: 'User already registered' } }),
  })
  assert.deepEqual(await authenticate(c, 'ana', '99'), { status: 'error', reason: 'taken' })
})

test('rede caida no login nao tenta cadastrar nem diz que a conta existe', async () => {
  const c = client({ signIn: async () => ({ data: {}, error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } }) })
  assert.deepEqual(await authenticate(c, 'ana', '12'), { status: 'error', reason: 'offline' })
  assert.equal(c.calls.signUp, 0)
})

test('limite de tentativas no login', async () => {
  const c = client({ signIn: async () => ({ data: {}, error: { status: 429, code: 'over_request_rate_limit', message: 'Request rate limit reached' } }) })
  assert.deepEqual(await authenticate(c, 'ana', '12'), { status: 'error', reason: 'busy' })
  assert.equal(c.calls.signUp, 0)
})

test('excecao vira offline, sem travar', async () => {
  const c = client({ signIn: async () => { throw new TypeError('Failed to fetch') } })
  assert.deepEqual(await authenticate(c, 'ana', '12'), { status: 'error', reason: 'offline' })
})

test('nome: acentos removidos e dicas', () => {
  assert.equal(cleanName('João Pé'), 'JoaoPe')
  assert.equal(cleanName('Conceição'), 'Conceicao')
  assert.equal(nameHint('ana'), '')
  assert.equal(nameHint('a'), '')
  assert.equal(nameHint('a', true), 'Mínimo 2 letras')
  assert.equal(nameHint('ana!'), 'Só letras, números, _ . -')
})
