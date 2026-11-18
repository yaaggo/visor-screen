// Mixer de audio por aplicativo (somente desktop).
// Cada app capturado pelo helper nativo chega como float32 estereo 48 kHz via IPC,
// vira um AudioWorkletNode e e mixado em uma unica MediaStreamTrack enviada no WebRTC.

const WORKLET = `
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.q = []
    this.head = 0
    this.size = 0
    this.port.onmessage = (e) => {
      this.q.push(e.data)
      this.size += e.data.length
      // segura no maximo ~120 ms; descarta o excesso para nao acumular atraso
      const max = 48000 * 2 * 0.12
      while (this.size - this.head > max && this.q.length > 1) {
        this.size -= this.q[0].length
        this.q.shift()
        this.head = 0
      }
    }
  }
  process(_in, outputs) {
    const out = outputs[0]
    const L = out[0], R = out[1] || out[0]
    for (let i = 0; i < L.length; i++) {
      let buf = this.q[0]
      if (buf && this.head >= buf.length) {
        this.size -= buf.length
        this.q.shift()
        this.head = 0
        buf = this.q[0]
      }
      if (!buf) { L[i] = 0; R[i] = 0; continue }
      L[i] = buf[this.head]
      R[i] = buf[this.head + 1]
      this.head += 2
    }
    return true
  }
}
registerProcessor('pcm-player', PcmPlayer)
`

export class AppAudioMixer {
  constructor(initialGain = 1) {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    this.dest = this.ctx.createMediaStreamDestination()
    this.dest.channelCount = 2
    this.gainNode = this.ctx.createGain()
    this.gainNode.gain.value = initialGain
    this.limiter = this.ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -1.5
    this.limiter.knee.value = 6
    this.limiter.ratio.value = 12
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.15
    this.gainNode.connect(this.limiter)
    this.limiter.connect(this.dest)
    this.nodes = new Map() // id -> AudioWorkletNode
    this.ready = this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })))
    this.offData = window.visor.onAudio((id, chunk) => {
      const node = this.nodes.get(id)
      if (!node) return
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      const f32 = new Float32Array(bytes.byteLength / 4)
      new Uint8Array(f32.buffer).set(bytes)
      node.port.postMessage(f32, [f32.buffer])
    })
    this.offEnd = window.visor.onAudioEnd((id) => this.detach(id))
    this.track.contentHint = 'music'
  }

  setGain(value) {
    const next = Math.max(0, Math.min(4, Number(value) || 0))
    this.gainNode.gain.setTargetAtTime(next, this.ctx.currentTime, 0.015)
  }

  get track() {
    return this.dest.stream.getAudioTracks()[0]
  }

  get ids() {
    return [...this.nodes.keys()]
  }

  // target: { pid, exclude }  — id estavel por alvo
  async set(targets) {
    await this.ready
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    const want = new Map(targets.map((t) => [`${t.exclude ? 'x' : 'p'}${t.pid}`, t]))
    for (const id of this.ids) if (!want.has(id)) this.detach(id)
    for (const [id, t] of want) {
      if (this.nodes.has(id)) continue
      const node = new AudioWorkletNode(this.ctx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] })
      node.connect(this.gainNode)
      this.nodes.set(id, node)
      await window.visor.audioStart(id, t.pid, !!t.exclude)
    }
  }

  detach(id) {
    const node = this.nodes.get(id)
    if (!node) return
    this.nodes.delete(id)
    node.disconnect()
    window.visor.audioStop(id)
  }

  close() {
    for (const id of this.ids) this.detach(id)
    this.offData()
    this.offEnd()
    this.track.stop()
    this.ctx.close()
  }
}
