// Replay de quem transmite: guarda os ultimos segundos da propria transmissao para salvar com F9.
//
// Caminho principal (WebCodecs, replayWorker.js): UM codificador H264 em hardware, num worker, com quadro-chave a
// cada 2 s e uma fila dos ultimos segundos ja codificados. F9 monta um MP4 a partir do quadro-chave certo: o clipe
// tem a duracao pedida (ate 2 s a mais), com duracao e busca corretas, e o arquivo vai ao disco com uma copia so.
//
// Reserva (MediaRecorder): sem WebCodecs/H264, dois gravadores se revezam (um WebM so pode comecar no cabecalho e
// num quadro-chave): cada um reinicia a cada 2x a duracao, defasados de 1x. Custa dois codificadores.
import { even, videoConfig } from './replayConfig.js'

const TYPES = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
const webcodecs = () => typeof VideoEncoder === 'function' && typeof AudioEncoder === 'function' &&
  typeof MediaStreamTrackProcessor === 'function' && typeof OffscreenCanvas === 'function'
export const replaySupported = () => webcodecs() || (typeof MediaRecorder === 'function' && TYPES.some(t => MediaRecorder.isTypeSupported(t)))

// Mesma interface nos dois caminhos: start(), addTrack(track), save() -> { data, ext, duration, thumb }, stop().
export class ReplayBuffer {
  // fps: o do preset (a track do motor Rust nao informa frameRate).
  constructor(stream, { seconds = 30, bitrate = 8_000_000, fps } = {}) {
    this.stream = stream
    this.opts = { seconds, bitrate, fps }
    this.closed = false
    this.kind = null
    this.pending = new Map()
    this.seq = 0
    this.clones = []
  }

  start() {
    this.ready = this.init().catch(() => this.fallback())
    return this
  }

  async init() {
    const [track] = this.stream.getVideoTracks()
    if (!track || !webcodecs()) return this.fallback()
    const s = track.getSettings()
    const fps = Math.round(Math.min(60, Math.max(15, this.opts.fps || s.frameRate || 30)))
    const config = videoConfig(even(s.width || 1920), even(s.height || 1080), fps, this.opts.bitrate)
    const { supported } = await VideoEncoder.isConfigSupported(config)
    if (this.closed) return
    if (!supported) return this.fallback()
    // Worker em blob (funciona em file:// no app instalado), carregado so quando o replay liga.
    const { default: ReplayWorker } = await import('./replayWorker.js?worker&inline')
    if (this.closed) return
    this.kind = 'webcodecs'
    this.worker = new ReplayWorker()
    this.worker.onmessage = ({ data }) => { this.pending.get(data.id)?.(data); this.pending.delete(data.id) }
    // A leitura dos quadros usa uma copia da track (parar o replay nao encerra a transmissao).
    const video = this.read(track)
    const [mic] = this.stream.getAudioTracks()
    const audio = mic ? this.read(mic) : null
    this.worker.postMessage({ type: 'start', seconds: this.opts.seconds, bitrate: this.opts.bitrate, fps, video, audio }, [video, audio].filter(Boolean))
  }

  read(track) {
    const clone = track.clone()
    this.clones.push(clone)
    return new MediaStreamTrackProcessor({ track: clone }).readable
  }

  fallback() {
    if (this.closed || this.legacy) return
    this.worker?.terminate()
    this.worker = null
    this.kind = 'mediarecorder'
    this.legacy = new MediaRecorderReplay(this.stream, this.opts).start()
  }

  request(type) {
    if (!this.worker) return Promise.resolve({})
    const id = ++this.seq
    return new Promise(resolve => { this.pending.set(id, resolve); this.worker.postMessage({ type, id }) })
  }

  // O audio do sistema (replay no Mudo) chega depois do video.
  async addTrack(track) {
    await this.ready
    if (this.closed) return
    this.stream = new MediaStream([...this.stream.getTracks(), track])
    if (this.legacy) return this.legacy.addTrack(track)
    const audio = this.read(track)
    this.worker?.postMessage({ type: 'audio', audio }, [audio])
  }

  async save() {
    await this.ready
    if (this.legacy) return this.legacy.save()
    const { clip } = await this.request('save')
    return clip ?? null
  }

  async stats() {
    await this.ready
    return this.legacy ? null : (await this.request('stats')).stats ?? null
  }

  stop() {
    this.closed = true
    this.legacy?.stop()
    this.worker?.postMessage({ type: 'stop' })
    const worker = this.worker
    // Da tempo ao worker de fechar os codificadores antes de encerrar.
    if (worker) setTimeout(() => worker.terminate(), 1000)
    this.worker = null
    for (const clone of this.clones) clone.stop()
    this.clones = []
    for (const resolve of this.pending.values()) resolve({})
    this.pending.clear()
  }
}

export class MediaRecorderReplay {
  constructor(stream, { seconds = 30, bitrate = 8_000_000 } = {}) {
    this.stream = stream
    this.seconds = seconds
    this.bitrate = bitrate
    this.type = TYPES.find(t => MediaRecorder.isTypeSupported(t))
    this.recorders = []
    this.closed = false
  }

  start() {
    this.recorders = [this.spawn(), null]
    // O segundo gravador entra defasado de `seconds`.
    this.offset = setTimeout(() => { if (!this.closed) this.recorders[1] = this.spawn() }, this.seconds * 1000)
    this.cycle = setInterval(() => {
      const limit = this.seconds * 2000
      this.recorders = this.recorders.map(r => r && performance.now() - r.at >= limit ? (this.drop(r), this.spawn()) : r)
    }, 1000)
    return this
  }

  // Uma track nova so entra em gravadores novos: recomeca os dois.
  addTrack(track) {
    if (this.closed) return
    this.stream = new MediaStream([...this.stream.getTracks(), track])
    clearTimeout(this.offset)
    clearInterval(this.cycle)
    for (const r of this.recorders) if (r) this.drop(r)
    this.start()
  }

  spawn() {
    const tracks = [...this.stream.getVideoTracks(), ...this.stream.getAudioTracks()].filter(t => t.readyState === 'live')
    const media = new MediaRecorder(new MediaStream(tracks), { mimeType: this.type, videoBitsPerSecond: this.bitrate, audioBitsPerSecond: 192_000 })
    const rec = { media, chunks: [], at: performance.now() }
    media.ondataavailable = e => { if (e.data.size) rec.chunks.push(e.data) }
    media.start(1000)
    return rec
  }

  drop(rec) {
    rec.media.ondataavailable = null
    if (rec.media.state !== 'inactive') rec.media.stop()
    rec.chunks = []
  }

  // Fecha o gravador mais antigo (o que tem mais tempo) e devolve o arquivo; ele recomeca na hora.
  async save() {
    const index = this.recorders.reduce((best, r, i) => r && (best < 0 || r.at < this.recorders[best].at) ? i : best, -1)
    if (index < 0) return null
    const rec = this.recorders[index]
    const duration = (performance.now() - rec.at) / 1000
    this.recorders[index] = this.spawn()
    const [blob, thumb] = await Promise.all([new Promise(resolve => {
      rec.media.onstop = () => resolve(new Blob(rec.chunks, { type: this.type.split(';')[0] }))
      rec.media.stop()
    }), this.thumbnail()])
    return { data: await blob.arrayBuffer(), ext: 'webm', duration: Math.round(duration), thumb }
  }

  // Miniatura do momento do F9 (quadro atual da track de video), em JPEG pequeno.
  async thumbnail() {
    const [track] = this.stream.getVideoTracks()
    try {
      const frame = await new ImageCapture(track).grabFrame()
      const c = document.createElement('canvas')
      const w = 320, h = Math.round(w * frame.height / frame.width)
      c.width = w; c.height = h
      c.getContext('2d').drawImage(frame, 0, 0, w, h)
      frame.close?.()
      return c.toDataURL('image/jpeg', .8)
    } catch { return null }
  }

  stop() {
    this.closed = true
    clearTimeout(this.offset)
    clearInterval(this.cycle)
    for (const r of this.recorders) if (r) this.drop(r)
    this.recorders = []
  }
}
