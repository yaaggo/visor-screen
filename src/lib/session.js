const invalidCodes = new Set([
  'bad_jwt', 'session_not_found', 'session_expired', 'user_not_found', 'user_banned',
  'refresh_token_not_found', 'refresh_token_already_used',
])

function authFailure(error) {
  return error.name === 'AuthSessionMissingError' || invalidCodes.has(error.code)
    ? { status: 'invalid' }
    : { status: 'retry' }
}

export async function restoreSession(client) {
  try {
    const session = await client.auth.getSession()
    if (session.error) return authFailure(session.error)
    if (!session.data.session) return { status: 'login' }
    const user = await client.auth.getUser()
    if (user.error) return authFailure(user.error)
    const { data, error } = await client.from('profiles').select('id, username').eq('id', user.data.user.id).maybeSingle()
    if (error) return { status: 'retry' }
    return data ? { status: 'ready', profile: data } : { status: 'login' }
  } catch {
    return { status: 'retry' }
  }
}
