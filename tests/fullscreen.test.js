import test from 'node:test'
import assert from 'node:assert/strict'

// O modulo le `document` ao carregar: um documento minimo antes do import.
globalThis.document = { fullscreenEnabled: true, fullscreenElement: null, addEventListener() {}, removeEventListener() {} }
globalThis.matchMedia = () => ({ matches: true })
const { enterFullscreen } = await import('../src/lib/fullscreen.js')

test('Android/desktop/iPad: o palco inteiro entra em tela cheia e trava em paisagem', async () => {
  const locks = []
  globalThis.screen = { orientation: { lock: async (o) => { locks.push(o) } } }
  const el = { requestFullscreen: async () => {} }
  const video = { videoWidth: 1920, videoHeight: 1080 }
  assert.equal(await enterFullscreen(el, video), 'element')
  assert.deepEqual(locks, ['landscape'])
})

test('video em retrato nao trava paisagem', async () => {
  const locks = []
  globalThis.screen = { orientation: { lock: async (o) => { locks.push(o) } } }
  assert.equal(await enterFullscreen({ requestFullscreen: async () => {} }, { videoWidth: 720, videoHeight: 1280 }), 'element')
  assert.deepEqual(locks, [])
})

test('iPhone: sem tela cheia de elemento, usa o player nativo do video', async () => {
  let native = 0
  const el = {} // div sem requestFullscreen
  const video = { webkitEnterFullscreen: () => { native++ } }
  assert.equal(await enterFullscreen(el, video), 'video')
  assert.equal(native, 1)
})

test('elemento recusado cai para o video', async () => {
  let native = 0
  const el = { requestFullscreen: async () => { throw new TypeError('Permissions check failed') } }
  assert.equal(await enterFullscreen(el, { webkitEnterFullscreen: () => { native++ } }), 'video')
  assert.equal(native, 1)
})

test('sem nenhum suporte: devolve null sem excecao', async () => {
  assert.equal(await enterFullscreen({}, {}), null)
})
