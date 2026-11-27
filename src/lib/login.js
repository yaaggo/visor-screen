// Conta = e-mail sintetico (nunca recebe e-mail; confirmacao desligada) + senha derivada do PIN.
// O prefixo existe porque o Supabase exige senha de 6+ caracteres; o segredo real e o PIN (1-4 caracteres).
export const NAME = /^[a-zA-Z0-9_.-]{2,20}$/
export const emailFor = (name) => `${name.toLowerCase()}@visor-screen.vercel.app`
export const passwordFor = (pin) => `visor-pin:${pin}`

// Acentos viram a letra simples (joão -> joao); espacos saem. O resto fica para a dica mostrar.
export const cleanName = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s/g, '')

// Dica curta no lugar do rotulo enquanto o nome nao e aceito.
// O minimo de 2 so aparece depois que a pessoa passou para a senha (nao na primeira letra).
export function nameHint(name, typingPin = false) {
  if (!name || NAME.test(name)) return ''
  if (/[^a-zA-Z0-9_.-]/.test(name)) return 'Só letras, números, _ . -'
  return typingPin ? 'Mínimo 2 letras' : ''
}

export const MESSAGES = {
  taken: 'Nome em uso ou senha errada',
  busy: 'Muitas tentativas, aguarde',
  offline: 'Sem conexão',
  retry: 'Tente de novo',
}

const rateLimited = (e) => e?.status === 429 || /rate.?limit/i.test(e?.code || '') || /rate limit/i.test(e?.message || '')
const offline = (e) => e?.name === 'AuthRetryableFetchError' || e?.status === 0 || e instanceof TypeError
const badCredentials = (e) => e?.code === 'invalid_credentials' || (e?.status === 400 && /invalid login credentials/i.test(e?.message || ''))
const exists = (e) => e?.code === 'user_already_exists' || /already (registered|exists)/i.test(e?.message || '')

function failure(e) {
  if (rateLimited(e)) return { status: 'error', reason: 'busy' }
  if (offline(e)) return { status: 'error', reason: 'offline' }
  return { status: 'error', reason: 'retry' }
}

// Entra; se o nome nao existe, cria a conta. So tenta criar quando o Supabase confirmou que a senha
// nao confere: uma queda de rede ou limite de tentativas no login nao vira "conta ja existe".
export async function authenticate(client, name, pin) {
  try {
    const email = emailFor(name)
    const password = passwordFor(pin)
    let { data, error } = await client.auth.signInWithPassword({ email, password })
    if (error) {
      if (!badCredentials(error)) return failure(error)
      const up = await client.auth.signUp({ email, password })
      if (up.error) return exists(up.error) ? { status: 'error', reason: 'taken' } : failure(up.error)
      if (!up.data?.session) return { status: 'error', reason: 'retry' }
      data = up.data
    }
    const session = data.session
    const found = await client.from('profiles').select('id, username').eq('id', session.user.id).maybeSingle()
    if (found.error) return failure(found.error)
    let profile = found.data
    if (!profile) {
      const ins = await client.from('profiles').insert({ id: session.user.id, username: name }).select('id, username').single()
      if (ins.error) return ins.error.code === '23505' ? { status: 'error', reason: 'taken' } : failure(ins.error)
      profile = ins.data
    }
    return { status: 'ok', session, profile }
  } catch (e) {
    return failure(e)
  }
}
