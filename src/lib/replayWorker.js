// Worker do replay: um unico codificador H264 (WebCodecs, hardware) com quadro-chave a cada 2 s e uma fila dos
// ultimos segundos ja codificados. F9 monta um MP4 a partir do quadro-chave certo, sem recodificar nada.
// Tudo fora da thread da interface: ler quadros, codificar, guardar e montar o arquivo.
//
// Relogio: tudo em microssegundos no relogio deste worker (performance.now).
// - Audio: o MediaStreamTrackProcessor ja entrega o timestamp de captura neste relogio (menos os primeiros
//   AudioData, que podem vir noutra base). O AudioEncoder do Chromium so usa o timestamp do primeiro e depois conta
//   amostras, entao o tempo de cada pacote vem do registro "amostra -> captura" guardado na entrada.
// - Video: timestamp de captura no relogio do sistema; a base (chegada - timestamp) e o menor valor visto nos
//   primeiros 2 s e depois fica fixa, entao o espacamento dos quadros e o da captura e o tempo nunca volta.
import { BufferTarget, EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny'
import { even, videoConfig } from './replayConfig.js'

const KEY_US = 2_000_000          // quadro-chave a cada 2 s: o clipe passa no maximo 2 s do pedido
const SETTLE_US = 2_000_000       // tempo para fixar a base do video
const JUMP_US = 3_000_000         // timestamps que saltam mais que isso = a track recomecou: nova base
const SANE_US = 1_000_000         // timestamp de audio a mais que isso da chegada esta noutra base
const GAP_US = 50_000             // buraco no audio (track sem dados) maior que isso vira silencio
const MAX_GAP_US = 30_000_000
const MAX_ERRORS = 3              // codificador falhando sem parar: desiste (o clipe sai vazio)

let opts = null, stopped = false
let video = [], audio = []        // { data, key, ts, cfg?, dur? }
let venc = null, vsize = '', vbase = null, vsince = 0, vlast = -Infinity, lastKey = -Infinity, vcfg = null
let aenc = null, acodec = null, acfg = null
let aRate = 48000, aSamples = 0, aFirstOut = null, aNext = null, aMarks = []  // aMarks: [{ from, ts }]
let wantThumb = null
const stats = { frames: 0, dropped: 0, bytes: 0, errors: 0 }
const nowUs = () => performance.now() * 1000

function openVideo(width, height) {
  try { venc?.close() } catch {}
  video = []; lastKey = -Infinity; vcfg = null
  vsize = width + 'x' + height
  venc = new VideoEncoder({
    output(chunk, meta) {
      if (meta?.decoderConfig) vcfg = meta.decoderConfig
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      const key = chunk.type === 'key'
      video.push({ data, key, ts: chunk.timestamp, cfg: key ? vcfg : null })
      stats.frames++; stats.bytes += data.byteLength
      if (key) trim()
    },
    error() { stats.errors++; venc = null; vsize = '' },
  })
  venc.configure(videoConfig(width, height, opts.fps, opts.bitrate))
}

// Mantem so o necessario: a partir do ultimo quadro-chave que ainda cobre `seconds` antes do quadro mais novo.
function trim() {
  const newest = video.at(-1).ts, limit = newest - opts.seconds * 1e6
  let cut = 0
  for (let i = 0; i < video.length; i++) if (video[i].key && video[i].ts <= limit) cut = i
  if (cut) video.splice(0, cut)
  const from = video[0].ts - 500_000
  let a = 0
  while (a < audio.length && audio[a].ts < from) a++
  if (a) audio.splice(0, a)
}

// Posicao do quadro no relogio do worker.
function videoTime(ts) {
  const now = nowUs(), d = now - ts
  if (vbase == null || Math.abs(d - vbase) > JUMP_US) { vbase = d; vsince = now }
  else if (now - vsince < SETTLE_US && d < vbase) vbase = d
  // Nunca volta (a base ainda descendo nos primeiros 2 s).
  const t = Math.max(ts + vbase, vlast + 1000)
  vlast = t
  return Math.round(t)
}

function onFrame(frame) {
  if (stats.errors >= MAX_ERRORS) { frame.close(); return }
  if (wantThumb) { const want = wantThumb; wantThumb = null; thumb(frame.clone()).then(want, () => want(null)) }
  const w = even(frame.displayWidth), h = even(frame.displayHeight)
  if (!venc || venc.state === 'closed' || vsize !== w + 'x' + h) openVideo(w, h)
  const ts = videoTime(frame.timestamp)
  // Codificador atrasado (GPU ocupada): descarta o quadro em vez de acumular atraso e memoria.
  if (venc.encodeQueueSize > 3) { stats.dropped++; frame.close(); return }
  const keyFrame = ts - lastKey >= KEY_US
  if (keyFrame) lastKey = ts
  // Mesmo quadro (sem copia) com o timestamp ja no relogio do worker: a saida do codificador vem pronta.
  const timed = new VideoFrame(frame, { timestamp: ts })
  frame.close()
  try { venc.encode(timed, { keyFrame }) } catch { stats.errors++ }
  timed.close()
}

async function thumb(frame) {
  try {
    const w = 320, h = Math.max(2, Math.round(w * frame.displayHeight / frame.displayWidth))
    const canvas = new OffscreenCanvas(w, h)
    canvas.getContext('2d').drawImage(frame, 0, 0, w, h)
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: .8 })).arrayBuffer())
  } finally { frame.close() }
}

// Tempo de captura da amostra `at` (contagem desde o inicio do codificador).
function sampleTime(at) {
  while (aMarks.length > 1 && aMarks[1].from <= at) aMarks.shift()
  const m = aMarks[0]
  return m.ts + (at - m.from) / aRate * 1e6
}

async function openAudio(sample) {
  const base = { sampleRate: sample.sampleRate, numberOfChannels: sample.numberOfChannels }
  for (const [codec, name] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const config = { ...base, codec, bitrate: 192_000 }
    if (!(await AudioEncoder.isConfigSupported(config).catch(() => ({}))).supported) continue
    acodec = name; aRate = sample.sampleRate; aSamples = 0; aFirstOut = null; aNext = null; aMarks = []
    const enc = new AudioEncoder({
      output(chunk, meta) {
        if (enc !== aenc || !aMarks.length) return
        if (meta?.decoderConfig) acfg = meta.decoderConfig
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        aFirstOut ??= chunk.timestamp
        const prev = audio.at(-1)
        const ts = Math.max(Math.round(sampleTime(Math.round((chunk.timestamp - aFirstOut) * aRate / 1e6))), prev ? prev.ts + 1 : -Infinity)
        audio.push({ data, key: true, ts, dur: chunk.duration })
      },
      error() { stats.errors++; if (aenc === enc) aenc = null },
    })
    enc.configure(config)
    aenc = enc
    return
  }
  acodec = 'none'
}

// Track que parou de entregar dados e voltou: silencio no lugar, para o arquivo nao ter buracos.
function silence(frames, like, ts) {
  aMarks.push({ from: aSamples, ts })
  const block = Math.round(like.sampleRate / 10)
  for (let left = frames; left > 0; left -= block) {
    const n = Math.min(block, left)
    const zeros = new AudioData({ format: 'f32-planar', sampleRate: like.sampleRate, numberOfChannels: like.numberOfChannels,
      numberOfFrames: n, timestamp: like.timestamp, data: new Float32Array(n * like.numberOfChannels) })
    try { aenc.encode(zeros) } catch { stats.errors++ }
    zeros.close()
    aSamples += n
  }
}

async function pump(readable, handle) {
  const reader = readable.getReader()
  try {
    while (!stopped) {
      const { value, done } = await reader.read()
      if (done) break
      if (stopped) { value.close(); break }
      await handle(value)
    }
  } catch {} finally { reader.cancel().catch(() => {}) }
}

function pumpAudio(readable) {
  let pending = []                // AudioData com timestamp noutra base, esperando o primeiro valido
  let arrival = false
  return pump(readable, async data => {
    if (!aenc && acodec !== 'none') await openAudio(data)
    if (!aenc || aenc.state !== 'configured') { data.close(); return }
    const frames = data.numberOfFrames, rate = data.sampleRate, now = nowUs()
    // Sem nenhum timestamp nesta base por 1 s: usa a hora de chegada (menos preciso, mas nunca sem audio).
    if (!arrival && pending.length > rate / frames) { arrival = true; for (const p of pending) aMarks.push({ from: p.from, ts: p.at }); pending = [] }
    const ts = arrival ? now : data.timestamp
    if (!arrival && Math.abs(ts - now) > SANE_US) pending.push({ from: aSamples, at: now })
    else {
      // Os anteriores sem base valida ficam colados antes deste.
      for (const p of pending) aMarks.push({ from: p.from, ts: ts - (aSamples - p.from) / rate * 1e6 })
      pending = []
      const gap = aNext == null ? 0 : ts - aNext
      if (!arrival && gap > GAP_US && gap < MAX_GAP_US) silence(Math.round(gap * aRate / 1e6), data, aNext)
      aMarks.push({ from: aSamples, ts })
      aNext = ts + frames / rate * 1e6
    }
    if (aMarks.length > 4096) aMarks.splice(0, aMarks.length - 4096)
    aSamples += frames
    try { aenc.encode(data) } catch { stats.errors++ }
    data.close()
  })
}

async function save() {
  if (video.length < 2) return null
  const end = video.at(-1).ts
  let start = 0
  for (let i = 0; i < video.length; i++) if (video[i].key && video[i].ts <= end - opts.seconds * 1e6) start = i
  while (start < video.length && !(video[start].key && video[start].cfg)) start++
  const clipVideo = video.slice(start)
  if (clipVideo.length < 2) return null
  const t0 = clipVideo[0].ts
  const frameUs = 1e6 / opts.fps
  const clipAudio = acodec && acodec !== 'none' && acfg ? audio.filter(a => a.ts >= t0 && a.ts <= end + frameUs) : []

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
  const vs = new EncodedVideoPacketSource('avc')
  // Sem frameRate: com ele o muxer arredonda os tempos para multiplos de 1/fps (quadros iguais no mesmo instante).
  output.addVideoTrack(vs)
  const as = clipAudio.length ? new EncodedAudioPacketSource(acodec) : null
  if (as) output.addAudioTrack(as)
  await output.start()
  // Pacotes intercalados por tempo (o muxer espera as duas tracks andarem juntas).
  const items = [
    ...clipVideo.map((c, i) => ({ c, v: true, i, dur: ((clipVideo[i + 1]?.ts ?? c.ts + frameUs) - c.ts) })),
    ...clipAudio.map((c, i) => ({ c, v: false, i, dur: c.dur ?? 21_333 })),
  ].sort((a, b) => a.c.ts - b.c.ts || (a.v ? -1 : 1))
  for (const { c, v, i, dur } of items) {
    const packet = new EncodedPacket(c.data, c.key ? 'key' : 'delta', (c.ts - t0) / 1e6, Math.max(1, dur) / 1e6)
    if (v) await vs.add(packet, i === 0 ? { decoderConfig: c.cfg } : undefined)
    else await as.add(packet, i === 0 ? { decoderConfig: acfg } : undefined)
  }
  await output.finalize()
  return { data: output.target.buffer, duration: Math.round((end - t0 + frameUs) / 1e6) }
}

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'start') {
    opts = { seconds: msg.seconds, fps: msg.fps, bitrate: msg.bitrate }
    pump(msg.video, onFrame)
    if (msg.audio) pumpAudio(msg.audio)
  } else if (msg.type === 'audio') {
    if (!aenc && acodec == null) pumpAudio(msg.audio)
  } else if (msg.type === 'save') {
    const thumbnail = new Promise(resolve => { wantThumb = resolve; setTimeout(() => { if (wantThumb === resolve) { wantThumb = null; resolve(null) } }, 600) })
    try {
      const [clip, jpeg] = await Promise.all([save(), thumbnail])
      const transfer = [clip?.data, jpeg?.buffer].filter(Boolean)
      self.postMessage({ id: msg.id, clip: clip && { ...clip, thumb: jpeg, ext: 'mp4' } }, transfer)
    } catch (error) {
      self.postMessage({ id: msg.id, clip: null, error: String(error?.message ?? error) })
    }
  } else if (msg.type === 'stats') {
    const bytes = list => list.reduce((s, c) => s + c.data.byteLength, 0)
    self.postMessage({ id: msg.id, stats: { ...stats, audio: acodec, memory: bytes(video) + bytes(audio),
      buffered: video.length ? (video.at(-1).ts - video[0].ts) / 1e6 : 0 } })
  } else if (msg.type === 'stop') {
    stopped = true
    try { venc?.close() } catch {}
    try { aenc?.close() } catch {}
    video = []; audio = []
    self.close()
  }
}
