// Sala de tela: presenca + sinalizacao WebRTC via Supabase Realtime (broadcast).
// Topologia: malha 1 -> N. Quem transmite abre um RTCPeerConnection por espectador.
// Fluxo: espectador envia `request` -> transmissor responde `offer` -> espectador `answer` -> `ice` dos dois lados.
import { getPreset, mungeAnswer, tuneSender, videoConstraints } from './quality.js'
import { API_BASE } from './env.js'
import { readInboundVideo, readOutboundVideo } from './screenStats.js'

const FALLBACK_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }]
let iceCache = null

async function loadIce() {
  if (iceCache) return iceCache
  try {
    const r = await fetch(`${API_BASE}/api/turn`, { cache: 'no-store' })
    const data = await r.json()
    iceCache = data.iceServers?.length ? data.iceServers : FALLBACK_ICE
  } catch {
    iceCache = FALLBACK_ICE
  }
  return iceCache
}

const uid = () => Math.random().toString(36).slice(2, 10)

export class ScreenRoom {
  constructor({ supabase, roomId, me, onChange }) {
    this.supabase = supabase
    this.roomId = roomId
    this.me = me // { id, name }
    this.onChange = onChange
    this.peers = [] // [{ id, name, sharing, shareId, preset }]
    this.local = null // MediaStream
    this.shareId = null
    this.preset = getPreset()
    this.bitrate = this.preset.bitrate
    this.cleanup = null // libera mixer/dispositivos da fonte atual
    this.uplink = null // menor availableOutgoingBitrate entre espectadores (bps)
    this.out = new Map() // viewerId -> RTCPeerConnection
    this.inPc = null
    this.inSid = null
    this.pendingIce = []
    this.watching = null // { id, shareId }
    this.remote = null // MediaStream
    this.stats = null // { width, height, fps, kbps }
    this.sendStats = null
    this.statsHistory = new WeakMap()
    this.pollingStats = false
    this.manual = false // espectador escolheu parar de assistir
    this.closed = false
  }

  emit() {
    if (this.closed) return
    this.onChange({
      peers: this.peers,
      sharing: !!this.local,
      local: this.local,
      remote: this.remote,
      watching: this.watching?.id ?? null,
      viewers: this.out.size,
      preset: this.preset.id,
      bitrate: this.bitrate,
      uplink: this.uplink,
      stats: this.stats,
      sendStats: this.sendStats,
      remoteAudio: !!this.remote?.getAudioTracks().length,
    })
  }

  async join() {
    this.ice = await loadIce()
    if (this.closed) return
    this.channel = this.supabase.channel(`screen:${this.roomId}`, {
      config: { broadcast: { self: false }, presence: { key: this.me.id } },
    })
    this.channel
      .on('presence', { event: 'sync' }, () => this.onPresence())
      .on('broadcast', { event: 'signal' }, ({ payload }) => {
        if (payload?.to === this.me.id) this.onSignal(payload)
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') this.track()
      })
    this.statsTimer = setInterval(() => this.pollStats(), 1000)
  }

  track() {
    return this.channel?.track({
      name: this.me.name,
      sharing: !!this.local,
      shareId: this.shareId,
      preset: this.preset.id,
    })
  }

  send(to, type, data = {}) {
    return this.channel?.send({ type: 'broadcast', event: 'signal', payload: { from: this.me.id, to, type, ...data } })
  }

  onPresence() {
    const state = this.channel.presenceState()
    this.peers = Object.entries(state).map(([id, metas]) => ({ id, ...metas[metas.length - 1] }))

    // viewers que sairam
    for (const id of [...this.out.keys()]) {
      if (!state[id]) this.closeOut(id)
    }

    const target = this.watching && this.peers.find((p) => p.id === this.watching.id)
    if (this.watching && (!target?.sharing || target.shareId !== this.watching.shareId)) {
      const restarted = target?.sharing
      this.stopWatching(false)
      if (restarted) this.watch(target.id)
    }
    if (!this.peers.some((p) => p.sharing && p.id !== this.me.id)) this.manual = false
    if (!this.watching && !this.manual) {
      const first = this.peers.find((p) => p.sharing && p.id !== this.me.id)
      if (first) this.watch(first.id)
    }
    this.emit()
  }

  // ---------- transmissor ----------

  // capture: { stream, cleanup } vindo de sources.js
  async startShare(capture, presetId, bitrate) {
    if (this.closed) {
      capture.stream.getTracks().forEach((t) => t.stop())
      capture.cleanup?.()
      return false
    }
    this.preset = getPreset(presetId)
    this.bitrate = bitrate ?? this.preset.bitrate
    const { stream } = capture
    const [video] = stream.getVideoTracks()
    video.contentHint = this.preset.fps >= 60 ? 'motion' : 'detail'
    video.addEventListener('ended', () => {
      if (this.local === stream) this.stopShare()
    }, { once: true })
    this.stopShare(false)
    this.local = stream
    this.cleanup = capture.cleanup
    this.shareId = uid()
    await this.track()
    this.emit()
    return this.local === stream
  }

  stopShare(announce = true) {
    if (!this.local) return
    this.local.getTracks().forEach((t) => t.stop())
    this.cleanup?.()
    this.cleanup = null
    this.uplink = null
    this.sendStats = null
    this.local = null
    this.shareId = null
    this.manual = false
    for (const id of [...this.out.keys()]) this.closeOut(id)
    if (announce) this.track()
    this.emit()
  }

  async setPreset(presetId) {
    this.preset = getPreset(presetId)
    if (this.local) {
      const [video] = this.local.getVideoTracks()
      video.contentHint = this.preset.fps >= 60 ? 'motion' : 'detail'
      await video.applyConstraints(videoConstraints(this.preset)).catch(() => {})
      await this.retune()
      this.track()
    }
    this.emit()
  }

  async setBitrate(bps) {
    this.bitrate = bps
    await this.retune()
    this.emit()
  }

  async retune() {
    for (const pc of this.out.values()) {
      for (const s of pc.getSenders()) if (s.track) await tuneSender(s, this.preset, this.bitrate)
    }
  }

  async serve(viewerId, sid) {
    if (!this.local) return this.send(viewerId, 'unavailable', { sid })
    this.closeOut(viewerId)
    const pc = new RTCPeerConnection({ iceServers: this.ice })
    pc.sid = sid
    this.out.set(viewerId, pc)
    const [video] = this.local.getVideoTracks()
    const sender = pc.addTrack(video, this.local)
    preferCodecs(pc.getTransceivers().find((t) => t.sender === sender))
    const audioSenders = this.local.getAudioTracks().map((t) => pc.addTrack(t, this.local))
    pc.onicecandidate = (e) => e.candidate && this.send(viewerId, 'ice', { sid, candidate: e.candidate.toJSON(), dir: 'down' })
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this.closeOut(viewerId)
      this.emit()
    }
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await tuneSender(sender, this.preset, this.bitrate)
    for (const a of audioSenders) await tuneSender(a, this.preset, this.bitrate)
    this.send(viewerId, 'offer', { sid, sdp: pc.localDescription.toJSON() })
    this.emit()
  }

  closeOut(viewerId) {
    const pc = this.out.get(viewerId)
    if (!pc) return
    pc.onconnectionstatechange = null
    pc.close()
    this.out.delete(viewerId)
    if (!this.out.size) {
      this.uplink = null
      this.sendStats = null
    }
  }

  // ---------- espectador ----------

  watch(sharerId) {
    const target = this.peers.find((p) => p.id === sharerId && p.sharing)
    if (!target) return
    this.stopWatching(false)
    this.manual = false
    this.watching = { id: target.id, shareId: target.shareId }
    this.inSid = uid()
    this.send(target.id, 'request', { sid: this.inSid })
    // re-tenta se nada chegar
    clearTimeout(this.retryTimer)
    const sid = this.inSid
    this.retryTimer = setTimeout(() => {
      if (this.inSid === sid && !this.remote) this.watch(sharerId)
    }, 6000)
    this.emit()
  }

  stopWatching(manual = true) {
    clearTimeout(this.retryTimer)
    if (this.inPc) {
      this.inPc.ontrack = null
      this.inPc.onconnectionstatechange = null
      this.inPc.close()
    }
    this.inPc = null
    this.inSid = null
    this.pendingIce = []
    this.remote = null
    this.stats = null
    this.watching = null
    if (manual) this.manual = true
    this.emit()
  }

  async answer(from, sid, sdp) {
    if (sid !== this.inSid || this.watching?.id !== from) return
    const pc = new RTCPeerConnection({ iceServers: this.ice })
    this.inPc = pc
    pc.ontrack = (e) => {
      this.remote = e.streams[0] ?? new MediaStream([e.track])
      clearTimeout(this.retryTimer)
      this.emit()
    }
    pc.onicecandidate = (e) => e.candidate && this.send(from, 'ice', { sid, candidate: e.candidate.toJSON(), dir: 'up' })
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && this.inPc === pc) {
        const id = this.watching?.id
        this.stopWatching(false)
        if (id) setTimeout(() => this.watch(id), 1500)
      }
    }
    await pc.setRemoteDescription(sdp)
    for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {})
    const ans = await pc.createAnswer()
    await pc.setLocalDescription(ans)
    this.send(from, 'answer', { sid, sdp: pc.localDescription.toJSON() })
  }

  // ---------- sinalizacao ----------

  async onSignal({ from, type, sid, sdp, candidate, dir }) {
    try {
      if (type === 'request') return this.serve(from, sid)
      if (type === 'offer') return this.answer(from, sid, sdp)
      if (type === 'answer') {
        const pc = this.out.get(from)
        if (pc?.sid === sid && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: sdp.type, sdp: mungeAnswer(sdp.sdp, this.bitrate) })
          await this.retune()
        }
        return
      }
      if (type === 'ice') {
        if (dir === 'up') {
          const pc = this.out.get(from)
          if (pc?.sid === sid) await pc.addIceCandidate(candidate).catch(() => {})
        } else if (sid === this.inSid) {
          if (this.inPc?.remoteDescription) await this.inPc.addIceCandidate(candidate).catch(() => {})
          else this.pendingIce.push(candidate)
        }
        return
      }
      if (type === 'unavailable' && sid === this.inSid) this.stopWatching(false)
    } catch (err) {
      console.warn('[screen] signal', type, err)
    }
  }

  // Guarda a ultima amostra por conexao e evita polls sobrepostos.
  async pollStats() {
    if (this.pollingStats || (!this.out.size && !this.inPc)) return
    this.pollingStats = true
    try {
      const share = this.local
      const inbound = this.inPc
      const outgoing = [...this.out]
      const samples = await Promise.all([
        this.sampleStats(inbound),
        ...outgoing.map(([, pc]) => this.sampleStats(pc)),
      ])
      if (this.closed) return

      let changed = false
      if (inbound && this.inPc === inbound) {
        this.stats = readInboundVideo(...samples[0])
        changed = true
      }
      if (share && this.local === share) {
        const viewers = outgoing.flatMap(([id, pc], i) => {
          if (this.out.get(id) !== pc) return []
          const sample = readOutboundVideo(...samples[i + 1])
          if (!sample) return []
          return [{ ...sample, id, name: this.peers.find((p) => p.id === id)?.name ?? '?' }]
        })
        const estimates = viewers.map((v) => v.uplink).filter((bps) => bps > 0)
        this.uplink = estimates.length ? Math.min(...estimates) : null
        this.sendStats = viewers.length ? { capture: viewers.find((v) => v.capture != null)?.capture, viewers } : null
        changed = true
      }
      if (changed) this.emit()
    } finally {
      this.pollingStats = false
    }
  }

  async sampleStats(pc) {
    if (pc?.connectionState !== 'connected') return []
    try {
      const report = await pc.getStats()
      const previous = this.statsHistory.get(pc)
      this.statsHistory.set(pc, report)
      return [report, previous]
    } catch {
      // A conexao pode fechar enquanto a amostra esta em andamento.
      return []
    }
  }

  leave() {
    this.stopShare(false)
    this.stopWatching(false)
    this.closed = true
    clearInterval(this.statsTimer)
    clearTimeout(this.retryTimer)
    if (this.channel) this.supabase.removeChannel(this.channel)
  }
}

// Prioriza H264 (encoder de hardware: sustentou ~45 Mbps 1080p60 em teste), depois VP9, AV1, VP8.
// VP8/VP9 por software travaram em ~13 Mbps com reducao de resolucao.
function preferCodecs(transceiver) {
  if (!transceiver?.setCodecPreferences || !RTCRtpSender.getCapabilities) return
  const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? []
  const rank = (c) => {
    const m = c.mimeType.toLowerCase()
    if (m === 'video/h264') return 0
    if (m === 'video/vp9') return 1
    if (m === 'video/av1') return 2
    if (m === 'video/vp8') return 3
    return 4
  }
  try {
    transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)))
  } catch {
    /* navegador sem suporte */
  }
}
