import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { build, createServer } from 'vite'

const profile = await mkdtemp(path.join(os.tmpdir(), 'visor-regression-'))
const user = { id: '6647a0c0-df42-43f3-9e35-e92d92d45dfe', email: 'qa@example.invalid', aud: 'authenticated' }
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const expiry = Math.floor(Date.now() / 1000) + 3600
const token = [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub:user.id, exp:expiry, role:'authenticated' }), 'dGVzdA'].join('.')
// Only the packaged renderer uses these local endpoints. Component tests control their own timing.
function mockBackend(req, res, next) {
  const url = new URL(req.url, 'http://localhost')
  if (!/^\/(auth|rest)\/v1\//.test(url.pathname)) return next()
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
  res.setHeader('Content-Type', 'application/json')
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password')
    res.end(JSON.stringify({ user, access_token:token, refresh_token:'local-qa', expires_in:3600, token_type:'bearer' }))
  else if (url.pathname === '/auth/v1/user') res.end(JSON.stringify(user))
  else if (url.pathname === '/rest/v1/profiles') res.end(JSON.stringify([{ id:user.id, username:'qa' }]))
  else if (url.pathname === '/rest/v1/servers') res.end(JSON.stringify([{ id:'local', name:'QA', owner_id:user.id }]))
  else if (url.pathname === '/rest/v1/channels') res.end(JSON.stringify([{ id:'sala', name:'tela', server_id:'local', kind:'screen' }]))
  else if (url.pathname.startsWith('/rest/v1/')) res.end('[]')
  else { res.statusCode = 404; res.end('{}') }
}

let vite
const httpServer = http.createServer((req, res) => {
  mockBackend(req, res, () => {
    if (vite) vite.middlewares(req, res)
    else { res.statusCode = 503; res.end() }
  })
})
await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
try {
  const runner = fileURLToPath(new URL('./window.cjs', import.meta.url))
  const base = `http://127.0.0.1:${httpServer.address().port}/`
  const output = path.join(profile, 'web-build')
  const devEnv = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = 'production'
    await build({ envDir: false, logLevel: 'error', define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(base.slice(0, -1)),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('qa'),
    }, build: { outDir: output } })
  } finally {
    if (devEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = devEnv
  }
  vite = await createServer({
    cacheDir: path.join(profile, 'vite-cache'),
    envDir: false,
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('http://127.0.0.1:1'),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('qa'),
    },
    server: { middlewareMode: true, hmr: false },
    logLevel: 'error',
  })
  console.log('QA local em', base)
  const child = spawn(electron, [runner], {
    env: { ...process.env, VISOR_QA_URL: base, VISOR_QA_PROFILE: profile, VISOR_QA_BUILD:output },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code !== 0) console.error('Electron encerrou com', code ?? signal)
      resolve(code ?? 1)
    })
  })
} finally {
  await vite?.close()
  await new Promise(resolve => httpServer.close(resolve))
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
