// Sala de tela: presenca + sinalizacao WebRTC via Supabase Realtime (broadcast).
// Topologia: malha 1 -> N. Quem transmite abre um RTCPeerConnection por espectador.
// Fluxo: espectador envia `request` -> transmissor responde `offer` -> espectador `answer` -> `ice` dos dois lados.
import { getPreset, mungeAnswer, tuneSender, tuneSide, videoConstraints } from './quality.js'
import { deviceKind, presencePublisher } from './presence.js'
import { API_BASE } from './env.js'
import { createIceLoader } from './ice.js'
import { readInboundVideo, readOutboundVideo } from './screenStats.js'

const loadIce = createIceLoader(`${API_BASE}/api/turn`)

const uid = () => Math.random().toString(36).slice(2, 10)
const GONE_MS = 15000

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
    this.gone = new Map() // viewerId -> timer: espectador fora da presenca, mas com conexao de envio aberta
    this.sendStats = null
    this.statsHistory = new WeakMap()
    this.pollingStats = false
    this.cam = null // { stream, track, audio, cleanup }: fonte camera
    this.camFlip = false // camera espelhada para todos (quem assiste espelha na exibicao)
    this.closed = false
  }

  get primary() { return this.inputs.values().next().value }
  get remote() { return this.primary?.stream ?? null }
  get inPc() { return this.primary?.pc ?? null }
  get stats() { return this.primary?.stats ?? null }

  emit() {
    if (this.closed) return
    this.onChange({
      connected: this.channel?.state === 'joined',
      peers: this.peers,
      sharing: this.sharing,
      local: this.local,
      remote: this.remote,
      watching: this.primary?.id ?? null,
      inputs: [...this.inputs.values()].map(({ id, stream, stats, preview, screenOn, cam, camStream, camFlip }) => ({ id, stream: screenOn === false ? null : stream, screen: screenOn !== false, stats, preview, cam: cam && camStream ? camStream : null, camFlip: !!camFlip })),
      camLocal: this.cam?.stream ?? null,
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
    if (!this.ice) void loadIce()
    if (this.closed) return
    this.publisher = presencePublisher(() => this.channel?.state === 'joined' && this.publishPresence(), {
      snapshot: () => JSON.stringify(this.presencePayload()),
      present: () => this.channel?.state !== 'joined' ? null : this.me.id in this.channel.presenceState(),
    })
    this.connect()
    this.statsTimer = setInterval(() => this.pollStats(), 1000)
    // Rede: o servidor pode fechar o canal (ex.: limite de presenca). Reabre sozinho.
    this.watchdog = setInterval(() => {
      if (!this.closed && ['closed', 'errored'].includes(this.channel?.state)) this.reconnect()
    }, 5000)
  }

  connect() {
    const channel = this.supabase.channel(`screen:${this.roomId}`, {
      config: { private: true, broadcast: { self: false }, presence: { key: this.me.id } },
    })
    this.channel = channel
    channel
      .on('presence', { event: 'sync' }, () => { if (this.channel === channel) this.onPresence() })
      .on('broadcast', { event: 'signal' }, ({ payload }) => {
        if (this.channel === channel && payload?.to === this.me.id) this.onSignal(payload)
      })
      .on('broadcast', { event: 'ping' }, ({ payload }) => { if (this.channel === channel) this.firePing(payload) })
      .subscribe((status) => {
        if (this.channel !== channel || this.closed) return
        if (status === 'SUBSCRIBED') { this.retryDelay = 0; this.publisher.reset() }
        if (status === 'CLOSED' || status === 'CHANNEL_ERROR') this.reconnect()
        this.emit()
      })
  }

  reconnect() {
    if (this.closed || this.reconnecting) return
    this.reconnecting = true
    this.retryDelay = Math.min(15000, (this.retryDelay || 1000) * 2)
    const old = this.channel
    setTimeout(() => {
      this.reconnecting = false
      if (this.closed || this.channel !== old) return
      this.supabase.removeChannel(old)
      this.connect()
    }, this.retryDelay)
  }

  track() {
    return this.publisher ? this.publisher.refresh() : undefined
  }

  presencePayload() {
    return {
      endpointId: this.me.id,
      profileId: this.me.profileId,
      name: this.me.name,
      photo: this.me.photo,
      device: this.me.device ?? deviceKind,
      watching: [...this.inputs.values()].filter((v) => !v.preview).map((v) => v.id),
      sharing: this.sharing,
      screen: !!this.local,
      cam: !!this.cam,
      shareId: this.shareId,
      preset: this.preset.id,
    }
  }

  publishPresence() {
    return this.channel?.track(this.presencePayload())
  }

  // Ping: Alt+clique num ponto de uma transmissao. Vai para a sala inteira; cada tela que mostra aquela
  // transmissao (inclusive a de quem transmite) desenha a onda no ponto. x/y normalizados (0..1) no video.
  ping(stream, x, y) {
    const payload = { from: this.me.id, profileId: this.me.profileId, name: this.me.name, stream, x, y }
    this.channel?.send({ type: 'broadcast', event: 'ping', payload })
    this.firePing(payload)
  }

  onPing(fn) {
    (this.pingListeners ??= new Set()).add(fn)
    return () => this.pingListeners.delete(fn)
  }

  firePing(p) {
    if (!p || typeof p.stream !== 'string' || !(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) return
    const ping = { from: String(p.from ?? ''), name: String(p.name ?? '').slice(0, 24), stream: p.stream, x: p.x, y: p.y, mine: p.from === this.me.id }
    for (const fn of this.pingListeners ?? []) fn(ping)
  }

  send(to, type, data = {}) {
    return this.channel?.send({ type: 'broadcast', event: 'signal', payload: { from: this.me.id, to, type, ...data } })
  }

  onPresence() {
    const state = this.channel.presenceState()
    this.peers = Object.entries(state).map(([id, metas]) => ({ id, ...metas[metas.length - 1] }))

    // Espectador fora da presenca: o canal dele pode ter caido e estar reabrindo (o Supabase fecha o canal de quem
    // estoura o limite de presenca). Fechar na hora deixava a tela dele parada sem novo pedido; espera GONE_MS.
    // Saida pela interface manda 'unwatch' (fecha na hora) e conexao que falha fecha pelo connectionState.
    for (const id of this.out.keys()) {
      if (state[id]) this.forgive(id)
      else if (!this.gone.has(id)) this.gone.set(id, setTimeout(() => this.expire(id), GONE_MS))
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
  // Duas fontes independentes: tela (this.local) e camera (this.cam), em qualquer ordem. Cada conexao com um
  // espectador tem sempre quatro trilhas fixas: video e audio da tela, video e audio da camera (vazias quando a
  // fonte esta desligada). Ligar, trocar ou desligar uma fonte e so replaceTrack + sinal 'slots', sem renegociar.
  // A fonte principal (a tela, ou a camera sozinha) usa a qualidade e o bitrate escolhidos; a camera ao lado da tela
  // usa tuneSide (teto baixo, ate 540p). Versoes antigas tocam a primeira trilha de video (a tela).

  get sharing() { return !!(this.local || this.cam) }
  get primaryVideo() { return this.local?.getVideoTracks()[0] ?? this.cam?.track ?? null }

  // capture: { stream, cleanup } vindo de sources.js
  async startShare(capture, presetId, bitrate) { return this.startScreen(capture, presetId, bitrate) }

  async startScreen(capture, presetId, bitrate) {
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
      if (this.local === stream) this.stopScreen()
    }, { once: true })
    this.dropScreen()
    this.local = stream
    this.cleanup = capture.cleanup
    this.captureEngine = capture.engine
    this.setCapturePreset = capture.setPreset
    this.getCaptureStats = capture.getStats
    this.shareId ??= uid()
    await this.pushSlots()
    await this.track()
    this.emit()
    return this.local === stream
  }

  // capture de captureDevice: { stream (video + audio opcional), cleanup, setAudioGain }
  async startCamera(capture, presetId, bitrate) {
    const [video] = capture.stream.getVideoTracks()
    if (this.closed || video?.readyState !== 'live') {
      capture.stream.getTracks().forEach((t) => t.stop())
      capture.cleanup?.()
      return false
    }
    if (!this.local) {
      this.preset = getPreset(presetId)
      this.bitrate = bitrate ?? this.preset.bitrate
    }
    video.contentHint = 'motion'
    const cam = { stream: capture.stream, track: video, audio: capture.stream.getAudioTracks()[0] ?? null, cleanup: capture.cleanup, setAudioGain: capture.setAudioGain }
    video.addEventListener('ended', () => { if (this.cam === cam) this.stopCamera() }, { once: true })
    this.dropCamera()
    this.cam = cam
    this.shareId ??= uid()
    await this.pushSlots()
    await this.track()
    this.emit()
    return this.cam === cam
  }

  dropScreen() {
    if (!this.local) return
    this.local.getTracks().forEach((t) => t.stop())
    this.cleanup?.()
    this.cleanup = null
    this.captureEngine = null
    this.setCapturePreset = null
    this.getCaptureStats = null
    this.local = null
  }

  dropCamera() {
    if (!this.cam) return
    this.cam.stream.getTracks().forEach((t) => t.stop())
    this.cam.cleanup?.()
    this.cam = null
  }

  stopScreen() {
    if (!this.local) return
    this.dropScreen()
    if (!this.cam) return this.stopShare()
    void this.pushSlots()
    this.track()
    this.emit()
  }

  stopCamera() {
    if (!this.cam) return
    this.dropCamera()
    if (!this.local) return this.stopShare()
    void this.pushSlots()
    this.track()
    this.emit()
  }

  // Para as duas fontes e fecha as conexoes de envio.
  stopShare(announce = true) {
    if (!this.local && !this.cam && !this.shareId) return
    this.dropScreen()
    this.dropCamera()
    this.uplink = null
    this.sendStats = null
    this.shareId = null
    for (const id of [...this.out.keys()]) this.closeOut(id)
    if (announce) this.track()
    this.emit()
  }

  async setPreset(presetId) {
    this.preset = getPreset(presetId)
    const video = this.primaryVideo
    if (video) {
      if (this.local) video.contentHint = this.preset.fps >= 60 ? 'motion' : 'detail'
      const constraints = this.local && this.setCapturePreset
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

  async tunePc(pc) {
    const t = pc.slots
    if (!t) return
    if (t.screen.track) await tuneSender(t.screen, this.preset, this.bitrate, true)
    if (t.cam.track) {
      if (this.local) await tuneSide(t.cam, t.cam.track)
      else await tuneSender(t.cam, this.preset, this.bitrate, true)
    }
    for (const a of [t.screenAudio, t.camAudio]) if (a.track) await tuneSender(a, this.preset, this.bitrate)
  }

  async retune() {
    for (const pc of this.out.values()) await this.tunePc(pc)
  }

  slotState() { return { screen: !!this.local, cam: !!this.cam, camFlip: this.camFlip } }

  setCamFlip(on) {
    if (this.camFlip === !!on) return
    this.camFlip = !!on
    for (const [viewerId, pc] of this.out) if (pc.slots) this.send(viewerId, 'slots', { sid: pc.sid, ...this.slotState() })
    this.emit()
  }

  async pushSlots() {
    const tracks = {
      screen: this.local?.getVideoTracks()[0] ?? null,
      screenAudio: this.local?.getAudioTracks()[0] ?? null,
      cam: this.cam?.track ?? null,
      camAudio: this.cam?.audio ?? null,
    }
    for (const [viewerId, pc] of this.out) {
      if (!pc.slots) continue
      for (const k of Object.keys(tracks)) {
        if (pc.slots[k].track !== tracks[k]) await pc.slots[k].replaceTrack(tracks[k]).catch(() => {})
      }
      await this.tunePc(pc)
      this.send(viewerId, 'slots', { sid: pc.sid, ...this.slotState() })
      this.send(viewerId, 'cam', { sid: pc.sid, on: !!this.cam }) // espectadores 1.18/1.19
    }
  }

  async serve(viewerId, sid) {
    if (!this.sharing) return this.send(viewerId, 'unavailable', { sid })
    this.closeOut(viewerId)
    const pc = new RTCPeerConnection({ iceServers: this.ice })
    pc.sid = sid
    pc.pendingIce = []
    this.out.set(viewerId, pc)
    if (!this.ice) {
      const iceServers = await loadIce()
      if (this.out.get(viewerId) !== pc) return
      pc.setConfiguration({ iceServers })
    }
    this.msScreen ??= new MediaStream()
    this.msCam ??= new MediaStream()
    const add = (track, kind, ms) => pc.addTransceiver(track ?? kind, { direction: 'sendonly', streams: [ms] })
    const screen = add(this.local?.getVideoTracks()[0], 'video', this.msScreen)
    const screenAudio = add(this.local?.getAudioTracks()[0], 'audio', this.msScreen)
    const cam = add(this.cam?.track, 'video', this.msScreen) // mesmo stream da tela: versoes antigas tocam a 1a trilha
    const camAudio = add(this.cam?.audio, 'audio', this.msCam)
    preferCodecs(screen)
    preferCodecs(cam)
    pc.slots = { screen: screen.sender, screenAudio: screenAudio.sender, cam: cam.sender, camAudio: camAudio.sender }
    pc.onicecandidate = (e) => e.candidate && this.send(viewerId, 'ice', { sid, candidate: e.candidate.toJSON(), dir: 'down' })
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this.closeOut(viewerId)
      this.emit()
    }
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await this.tunePc(pc)
    this.send(viewerId, 'offer', { sid, sdp: pc.localDescription.toJSON(), cam: !!this.cam, slots: this.slotState() })
    this.emit()
  }

  forgive(viewerId) {
    clearTimeout(this.gone.get(viewerId))
    this.gone.delete(viewerId)
  }

  expire(viewerId) {
    this.gone.delete(viewerId)
    if (this.closed || !this.out.has(viewerId)) return
    // Com o proprio canal reabrindo a presenca nao e confiavel: confere de novo depois.
    if (this.channel?.state !== 'joined') return void this.gone.set(viewerId, setTimeout(() => this.expire(viewerId), 5000))
    if (viewerId in this.channel.presenceState()) return
    this.closeOut(viewerId)
    this.emit()
  }

  closeOut(viewerId) {
    this.forgive(viewerId)
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

  async answer(from, sid, sdp, cam = false, slots = null) {
    const input = this.inputs.get(from)
    if (!input || input.sid !== sid || input.pc) return
    input.cam = !!(slots ? slots.cam : cam)
    input.screenOn = slots ? !!slots.screen : true
    input.camFlip = !!slots?.camFlip
    const pc = new RTCPeerConnection({ iceServers: this.ice })
    input.pc = pc
    if (!this.ice) {
      const iceServers = await loadIce()
      if (this.inputs.get(from) !== input) return
      pc.setConfiguration({ iceServers })
    }
    pc.ontrack = (e) => {
      // Give a 60 fps viewer a few frames to absorb uneven packet arrival.
      if (e.track.kind === 'video' && 'jitterBufferTarget' in e.receiver) {
        try { e.receiver.jitterBufferTarget = 80 } catch { /* optional receiver hint */ }
      }
      // A segunda trilha de cada tipo (video e audio) e da camera de quem transmite: fica fora do stream da tela.
      const same = pc.getTransceivers().filter((t) => t.receiver.track?.kind === e.track.kind)
      if (same.indexOf(e.transceiver) > 0) {
        input.camStream ??= new MediaStream()
        if (!input.camStream.getTracks().includes(e.track)) input.camStream.addTrack(e.track)
        return this.emit()
      }
      if (!input.stream) input.stream = new MediaStream()
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

  async onSignal({ from, type, sid, sdp, candidate, dir, cam, on, slots, screen, camFlip }) {
    try {
      if (type === 'unwatch' && this.out.get(from)?.sid === sid) {
        this.closeOut(from)
        return this.emit()
      }
      if (type === 'request') return await this.serve(from, sid)
      if (type === 'offer') return await this.answer(from, sid, sdp, cam, slots)
      if (type === 'cam') {
        const input = this.inputs.get(from)
        if (input?.sid === sid) { input.cam = !!on; this.emit() }
        return
      }
      if (type === 'slots') {
        const input = this.inputs.get(from)
        if (input?.sid === sid) { input.cam = !!cam; input.screenOn = !!screen; input.camFlip = !!camFlip; this.emit() }
        return
      }
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
      const share = this.shareId
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
          const stats = readInboundVideo(...samples[0][i])
          if (stats?.freezeDelta > 0) input.lastFreeze = {
            at: Date.now(), duration: stats.freezeMs, loss: stats.loss, jitter: stats.jitter,
            bufferMs: stats.bufferMs, decodeMs: stats.decodeMs, dropped: stats.dropped
          }
          input.stats = stats && { ...stats, lastFreeze: input.lastFreeze }
          changed = true
        }
      })
      if (share && this.shareId === share) {
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
    clearInterval(this.watchdog)
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
