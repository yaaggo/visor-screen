// Replay de quem transmite: guarda os ultimos segundos da propria transmissao para salvar com F9.
// Um WebM so pode ser cortado no comeco se tiver o cabecalho e comecar num quadro-chave, entao em vez de
// cortar, dois gravadores se revezam: cada um reinicia a cada 2x a duracao, defasados de 1x. Sempre ha um
// com pelo menos `seconds` gravados; o clipe salvo tem entre `seconds` e 2x `seconds`, e e um arquivo valido.
// Gravar usa o codificador do navegador (H264 em hardware quando disponivel), por isso e opcional.

const TYPES = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
export const replaySupported = () => typeof MediaRecorder === 'function' && TYPES.some(t => MediaRecorder.isTypeSupported(t))

export class ReplayBuffer {
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
    const blob = await new Promise(resolve => {
      rec.media.onstop = () => resolve(new Blob(rec.chunks, { type: this.type.split(';')[0] }))
      rec.media.stop()
    })
    return { blob, duration: Math.round(duration) }
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
