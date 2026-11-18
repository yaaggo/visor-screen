import { writeFile } from 'node:fs/promises'
import { setTimeout as wait } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '9333' },
    'viewer-port': { type: 'string' },
    source: { type: 'string' },
    preset: { type: 'string', default: '1080p60' },
    mbps: { type: 'string', default: '12' },
    samples: { type: 'string', default: '15' },
    warmup: { type: 'string', default: '4' },
    'require-resolution': { type: 'string' },
    rounds: { type: 'string', default: 'chromium,rust,rust,chromium' },
    out: { type: 'string' },
    list: { type: 'boolean', default: false },
  },
})

const engines = args.rounds.split(',')
const mbps = Number(args.mbps)
const samples = Number(args.samples)
const warmup = Number(args.warmup)
const requiredResolution = args['require-resolution']
if (!args.list && !args.source) throw new Error('Informe --source com o ID ou título exato, ou use --list.')
if (engines.some((engine) => !['chromium', 'rust'].includes(engine))) throw new Error('--rounds aceita chromium e rust.')
if (!Number.isInteger(samples) || samples < 3 || samples > 120) throw new Error('--samples deve estar entre 3 e 120.')
if (!(mbps >= 2 && mbps <= 50)) throw new Error('--mbps deve estar entre 2 e 50.')
if (!Number.isInteger(warmup) || warmup < 0 || warmup > 60) throw new Error('--warmup deve estar entre 0 e 60 segundos.')
if (requiredResolution && !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(requiredResolution)) throw new Error('Use --require-resolution 1920x1080.')

async function connect(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) }).then((response) => response.json())
  const tab = targets.find((target) => target.type === 'page' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(target.url))
  if (!tab) throw new Error(`Abra o Visor local (Vite) no alvo CDP ${port}.`)
  const socket = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Conexão CDP expirou')) }, 4000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Falha no CDP')) }, { once: true })
  })
  let id = 0
  let onSignal
  const pending = new Map()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Runtime.bindingCalled') {
      if (message.params.name === '__visorCompareSignal') onSignal?.(JSON.parse(message.params.payload))
      return
    }
    const request = pending.get(message.id)
    if (request) {
      pending.delete(message.id)
      request(message)
    }
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const request = ++id
    const timer = setTimeout(() => {
      pending.delete(request)
      reject(new Error(`CDP expirou em ${method}`))
    }, 10_000)
    pending.set(request, ({ error, result }) => {
      clearTimeout(timer)
      if (error) reject(new Error(error.message))
      else resolve(result)
    })
    socket.send(JSON.stringify({ id: request, method, params }))
  })
  return {
    close: () => socket.close(),
    async relay(callback) {
      onSignal = callback
      await call('Runtime.addBinding', { name: '__visorCompareSignal' })
    },
    async evaluate(fn, ...params) {
      const expression = `(${fn})(...(${JSON.stringify(params)}))`
      const { result, exceptionDetails } = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
      return result.value
    },
  }
}

async function createRoom(role, source, engine, preset, rate) {
  const { ScreenRoom } = await import('/src/lib/screen.js')
  const { getPreset } = await import('/src/lib/quality.js')
  const rooms = (window.__visorCompareRooms ??= new Map())
  const other = role === 'sender' ? 'viewer' : 'sender'
  const video = role === 'viewer' ? document.createElement('video') : null
  const presentation = []
  let videoCallback
  if (video) {
    video.style.cssText = 'position:fixed;inset:0 auto auto 0;width:320px;height:180px;z-index:1000'
    video.muted = true
    video.autoplay = true
    document.body.append(video)
    if (video.requestVideoFrameCallback) {
      let previous
      const sample = (_now, meta) => {
        const shown = meta.expectedDisplayTime
        presentation.push({
          gapMs: previous == null ? null : shown - previous,
          captureToDisplayMs: meta.captureTime == null ? null : shown - meta.captureTime,
          receiveToDisplayMs: meta.receiveTime == null ? null : shown - meta.receiveTime,
        })
        previous = shown
        videoCallback = video.requestVideoFrameCallback(sample)
      }
      videoCallback = video.requestVideoFrameCallback(sample)
    }
  }
  const room = new ScreenRoom({
    supabase: { removeChannel() {} },
    roomId: 'capture-comparison',
    me: { id: role, name: role },
    onChange(state) {
      if (video && video.srcObject !== state.remote) video.srcObject = state.remote
    },
  })
  rooms.set(role, { room, video, presentation, stopPresentation: () => video?.cancelVideoFrameCallback?.(videoCallback) })
  room.ice = []
  room.channel = { track() {}, send: ({ payload }) => window.__visorCompareSignal(JSON.stringify(payload)) }
  room.statsTimer = setInterval(() => room.pollStats(), 1000)
  room.peers = [{ id: other, name: other }]
  if (role === 'sender') {
    const quality = getPreset(preset)
    if (quality.id !== preset) throw new Error('Preset desconhecido')
    const { captureDesktop } = await import('/src/lib/sources.js')
    const capture = await captureDesktop(source, quality, [], engine)
    await room.startShare(capture, quality.id, rate)
    await window.visor.boost(true)
    return room.shareId
  }
}

function dispose(role) {
  const rooms = window.__visorCompareRooms
  const entry = rooms?.get(role)
  entry?.room.leave()
  entry?.stopPresentation()
  entry?.video?.remove()
  rooms?.delete(role)
  if (role === 'sender') return window.visor?.boost(false)
}

function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  return { min: sorted[0], median, max: sorted.at(-1) }
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? Math.round(sorted[Math.ceil(sorted.length * fraction) - 1]) : null
}

const sender = await connect(args.port)
let viewer
try {
  const sources = await sender.evaluate(async () => (await window.visor.sources()).map(({ id, name, kind }) => ({ id, name, kind })))
  if (args.list) {
    console.table(sources)
    process.exitCode = 0
  } else {
    const exact = sources.find((source) => source.id === args.source)
    const byName = sources.filter((source) => source.name === args.source)
    const source = exact ?? (byName.length === 1 ? byName[0] : null)
    if (!source) throw new Error('Fonte indisponível ou ambígua. Use --list e informe o ID exato.')
    if (engines.includes('rust') && !await sender.evaluate(() => window.visor.captureAvailable())) throw new Error('Motor Rust indisponível nesta instância.')
    viewer = args['viewer-port'] && args['viewer-port'] !== args.port ? await connect(args['viewer-port']) : sender
    const relay = (payload) => {
      const peer = payload.to === 'sender' ? sender : viewer
      peer.evaluate((msg) => window.__visorCompareRooms?.get(msg.to)?.room.onSignal(msg), payload).catch((error) => console.warn(error.message))
    }
    await sender.relay(relay)
    if (viewer !== sender) await viewer.relay(relay)
    const browser = await viewer.evaluate(() => navigator.userAgent)
    const setup = { source, browser, preset: args.preset, mbps, samples, warmup, requiredResolution, engines, separateViewer: viewer !== sender }
    console.log(JSON.stringify(setup))
    const rounds = []
    for (const engine of engines) {
      try {
        await viewer.evaluate(createRoom, 'viewer')
        const shareId = await sender.evaluate(createRoom, 'sender', source.id, engine, args.preset, mbps * 1_000_000)
        await viewer.evaluate((id, preset) => {
          const { room } = window.__visorCompareRooms.get('viewer')
          room.peers = [{ id: 'sender', name: 'sender', sharing: true, shareId: id, preset }]
          room.watch('sender')
        }, shareId, args.preset)
        for (let attempt = 0; attempt < 12; attempt++) {
          if (await viewer.evaluate(() => window.__visorCompareRooms.get('viewer').room.stats?.decoded > 0)) break
          if (attempt === 11) throw new Error(`Nenhum quadro decodificado com ${engine}`)
          await wait(1000)
        }
        await wait(warmup * 1000)
        await viewer.evaluate(() => { window.__visorCompareRooms.get('viewer').presentation.length = 0 })
        const rows = []
        for (let i = 0; i < samples; i++) {
          const [tx, viewerSample] = await Promise.all([
            sender.evaluate(() => {
              const { room } = window.__visorCompareRooms.get('sender')
              return { capture: room.sendStats?.capture, native: room.getCaptureStats?.(), out: room.sendStats?.viewers[0] }
            }),
            viewer.evaluate(() => {
              const { room, presentation } = window.__visorCompareRooms.get('viewer')
              return { rx: room.stats, playback: presentation.splice(0) }
            }),
          ])
          rows.push({ tx, ...viewerSample })
          if (i + 1 < samples) await wait(1050)
        }
        const receivedResolutions = {}
        for (const { rx } of rows) {
          const size = rx?.width && rx.height ? `${rx.width}x${rx.height}` : 'indisponível'
          receivedResolutions[size] = (receivedResolutions[size] ?? 0) + 1
        }
        const playback = rows.flatMap((row) => row.playback)
        const summary = {
          capture: summarize(rows.map((row) => row.tx.capture)),
          encoded: summarize(rows.map((row) => row.tx.out?.encoded)),
          sent: summarize(rows.map((row) => row.tx.out?.fps)),
          decoded: summarize(rows.map((row) => row.rx?.decoded)),
          sentKbps: summarize(rows.map((row) => row.tx.out?.kbps)),
          receivedResolutions,
          gapP95Ms: percentile(playback.map((frame) => frame.gapMs), 0.95),
          captureP95Ms: percentile(playback.map((frame) => frame.captureToDisplayMs), 0.95),
          receiveP95Ms: percentile(playback.map((frame) => frame.receiveToDisplayMs), 0.95),
          sendQueueP95Ms: percentile(rows.map(({ tx }) => tx.out?.sendQueueMs), 0.95),
          bufferP95Ms: percentile(rows.map(({ rx }) => rx?.bufferMs), 0.95),
          viewerDrops: rows.reduce((sum, row) => sum + (row.rx?.dropped ?? 0), 0),
          viewerFreezes: Math.max(0, (rows.at(-1).rx?.freezes ?? 0) - (rows[0].rx?.freezes ?? 0)),
          nativeQueueDrops: rows.reduce((sum, { tx }) => sum + (tx.native?.busy ?? 0)
            + (tx.native?.bridgeDrops ?? 0) + (tx.native?.writerDrops ?? 0), 0),
        }
        rounds.push({ engine, summary, rows })
        if (args.out) await writeFile(args.out, JSON.stringify({ setup, rounds }, null, 2) + '\n')
        console.log(JSON.stringify({ engine, ...summary }))
        if (requiredResolution && receivedResolutions[requiredResolution] !== samples) {
          console.error(`${engine}: ${receivedResolutions[requiredResolution] ?? 0}/${samples} amostras a ${requiredResolution}.`)
          process.exitCode = 1
        }
      } finally {
        await Promise.allSettled([sender.evaluate(dispose, 'sender'), viewer.evaluate(dispose, 'viewer')])
      }
    }
  }
} finally {
  if (viewer !== sender) viewer?.close()
  sender.close()
}
