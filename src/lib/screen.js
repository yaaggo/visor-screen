// Sala de tela: presenca + sinalizacao WebRTC via Supabase Realtime (broadcast).
// Topologia: malha 1 -> N. Quem transmite abre um RTCPeerConnection por espectador.
// Fluxo: espectador envia `request` -> transmissor responde `offer` -> espectador `answer` -> `ice` dos dois lados.
import { getPreset, mungeAnswer, tuneSender, videoConstraints } from './quality.js'
import { deviceKind, presencePublisher } from './presence.js'
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
    this.captureEngine = null
    this.setCapturePreset = null
    this.getCaptureStats = null
    this.uplink = null // menor availableOutgoingBitrate entre espectadores (bps)
    this.out = new Map() // viewerId -> RTCPeerConnection
    this.inputs = new Map()
    this.sendStats = null
    this.statsHistory = new WeakMap()
    this.pollingStats = false
    this.closed = false
  }

  get primary() { return this.inputs.values().next().value }
  get remote() { return this.primary?.stream ?? null }
  get inPc() { return this.primary?.pc ?? null }
  get stats() { return this.primary?.stats ?? null }

  emit() {
    if (this.closed) return
    this.onChange({
      peers: this.peers,
      sharing: !!this.local,
      local: this.local,
      remote: this.remote,
      watching: this.primary?.id ?? null,
      inputs: [...this.inputs.values()].map(({ id, stream, stats, preview }) => ({ id, stream, stats, preview })),
      viewers: this.out.size,
      preset: this.preset.id,
      bitrate: this.bitrate,
      uplink: this.uplink,
      stats: this.stats,
      sendStats: this.sendStats,
      captureEngine: this.captureEngine,
      captureStats: this.getCaptureStats?.(),
      remoteAudio: !!this.remote?.getAudioTracks().length,
    })
  }

  async join() {
    this.ice = await loadIce()
    if (this.closed) return
    this.channel = this.supabase.channel(`screen:${this.roomId}`, {
      config: { broadcast: { self: false }, presence: { key: this.me.id } },
    })
    this.publisher = presencePublisher(() => this.channel.state === 'joined' && this.publishPresence())
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
    return this.publisher ? this.publisher.refresh() : this.publishPresence()
  }

  publishPresence() {
    return this.channel?.track({
      endpointId: this.me.id,
      profileId: this.me.profileId,
      name: this.me.name,
      photo: this.me.photo,
      device: this.me.device ?? deviceKind,
      watching: [...this.inputs.values()].filter((v) => !v.preview).map((v) => v.id),
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

    for (const input of this.inputs.values()) {
      const peer = this.peers.find((p) => p.id === input.id)
      if (!peer) continue
      if (!peer.sharing || (input.shareId && peer.shareId !== input.shareId)) {
        this.stopWatching(input.id)
        if (peer.sharing) this.watch(peer.id, input.preview)
      } else if (!input.shareId && peer.shareId) {
        input.shareId = peer.shareId
      }
    }
    this.emit()
  }

  // ---------- transmissor ----------

  // capture: { stream, cleanup } vindo de sources.js
  async startShare(capture, presetId, bitrate) {
    if (this.closed || capture.stream.getVideoTracks()[0]?.readyState !== 'live') {
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
    this.captureEngine = capture.engine
    this.setCapturePreset = capture.setPreset
    this.getCaptureStats = capture.getStats
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
    this.captureEngine = null
    this.setCapturePreset = null
    this.getCaptureStats = null
    this.uplink = null
    this.sendStats = null
    this.local = null
    this.shareId = null
    for (const id of [...this.out.keys()]) this.closeOut(id)
    if (announce) this.track()
    this.emit()
  }

  async setPreset(presetId) {
    this.preset = getPreset(presetId)
    if (this.local) {
      const [video] = this.local.getVideoTracks()
      video.contentHint = this.preset.fps >= 60 ? 'motion' : 'detail'
      const constraints = this.setCapturePreset
        ? this.setCapturePreset(this.preset)
        : video.applyConstraints(videoConstraints(this.preset))
      await constraints.catch(() => {})
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
      for (const sender of pc.getSenders()) {
        if (sender.track) await tuneSender(sender, this.preset, this.bitrate, true)
      }
    }
  }

  async serve(viewerId, sid) {
    if (!this.local) return this.send(viewerId, 'unavailable', { sid })
    this.closeOut(viewerId)
    const pc = new RTCPeerConnection({ iceServers: this.ice })
    pc.sid = sid
    pc.pendingIce = []
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
    await tuneSender(sender, this.preset, this.bitrate, true)
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

  watch(id, preview = false, peerHint = null) {
    const peer = this.peers.find((p) => p.id === id && p.sharing) ?? (peerHint?.sharing ? peerHint : null)
    if (!peer || id === this.me.id || this.closed) return
    const current = this.inputs.get(id)
    if (current) {
      if (!preview && current.preview) {
        current.preview = false
        this.track()
        this.emit()
      }
      return
    }
    const input = { id, shareId: peer.shareId, preview, sid: uid(), candidates: [], stream: null, stats: null }
    this.inputs.set(id, input)
    const retry = () => {
      if (this.inputs.get(id) !== input || input.pc?.connectionState === 'connected') return
      this.stopWatching(id)
      this.watch(id, input.preview)
    }
    input.retry = retry
    input.timer = setTimeout(retry, 9000)
    this.send(id, 'request', { sid: input.sid })
    if (!preview) this.track()
    this.emit()
  }

  stopWatching(id) {
    if (id == null) {
      for (const key of [...this.inputs.keys()]) this.stopWatching(key)
      return
    }
    const input = this.inputs.get(id)
    if (!input) return
    this.inputs.delete(id)
    clearTimeout(input.timer)
    this.send(id, 'unwatch', { sid: input.sid })
    if (input.pc) {
      input.pc.onconnectionstatechange = input.pc.ontrack = null
      input.pc.close()
    }
    if (!input.preview && !this.closed) this.track()
    this.emit()
  }

  async answer(from, sid, sdp) {
    const input = this.inputs.get(from)
    if (!input || input.sid !== sid || input.pc) return
    const pc = new RTCPeerConnection({ iceServers: this.ice })
    input.pc = pc
    pc.ontrack = (e) => {
      // Give a 60 fps viewer a few frames to absorb uneven packet arrival.
      if (e.track.kind === 'video' && 'jitterBufferTarget' in e.receiver) {
        try { e.receiver.jitterBufferTarget = 80 } catch { /* optional receiver hint */ }
      }
      input.stream = e.streams[0] ?? input.stream ?? new MediaStream()
      if (!input.stream.getTracks().includes(e.track)) input.stream.addTrack(e.track)
      this.emit()
    }
    pc.onicecandidate = (e) => e.candidate && this.send(from, 'ice', { sid, candidate: e.candidate.toJSON(), dir: 'up' })
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') input.retry()
      if (pc.connectionState === 'connected') clearTimeout(input.timer)
    }
    await pc.setRemoteDescription(sdp)
    for (const c of input.candidates.splice(0)) await pc.addIceCandidate(c).catch(() => {})
    await pc.setLocalDescription(await pc.createAnswer())
    if (this.inputs.get(from) === input) this.send(from, 'answer', { sid, sdp: pc.localDescription.toJSON() })
  }

  // ---------- sinalizacao ----------

  async onSignal({ from, type, sid, sdp, candidate, dir }) {
    try {
      if (type === 'unwatch' && this.out.get(from)?.sid === sid) {
        this.closeOut(from)
        return this.emit()
      }
      if (type === 'request') return await this.serve(from, sid)
      if (type === 'offer') return await this.answer(from, sid, sdp)
      if (type === 'answer') {
        const pc = this.out.get(from)
        if (pc?.sid === sid && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: sdp.type, sdp: mungeAnswer(sdp.sdp, this.bitrate) })
          for (const c of pc.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {})
          await this.retune()
        }
        return
      }
      if (type === 'ice') {
        if (dir === 'up') {
          const pc = this.out.get(from)
          if (pc?.sid === sid) {
            if (pc.remoteDescription) await pc.addIceCandidate(candidate)
            else pc.pendingIce.push(candidate)
          }
        } else {
          const input = this.inputs.get(from)
          if (input?.sid !== sid) return
          if (input.pc?.remoteDescription) await input.pc.addIceCandidate(candidate)
          else input.candidates.push(candidate)
        }
      }
      if (type === 'unavailable' && this.inputs.get(from)?.sid === sid) this.stopWatching(from)
    } catch (err) {
      console.warn('[screen] signal', type, err)
    }
  }

  // Guarda a ultima amostra por conexao e evita polls sobrepostos.
  async pollStats() {
    if (this.pollingStats || (!this.out.size && !this.inputs.size && !this.getCaptureStats)) return
    this.pollingStats = true
    try {
      const share = this.local
      const inbound = [...this.inputs.values()]
      const outgoing = [...this.out]
      const samples = await Promise.all([
        Promise.all(inbound.map((input) => this.sampleStats(input.pc))),
        ...outgoing.map(([, pc]) => this.sampleStats(pc)),
      ])
      if (this.closed) return

      let changed = false
      inbound.forEach((input, i) => {
        if (this.inputs.get(input.id) === input) {
          input.stats = readInboundVideo(...samples[0][i])
          changed = true
        }
      })
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
    this.publisher?.close()
    this.closed = true
    this.stopShare(false)
    this.stopWatching()
    clearInterval(this.statsTimer)
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
