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
      connected: this.channel?.state === 'joined',
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
      sharing: !!this.local,
      shareId: this.shareId,
      preset: this.preset.id,
    }
  }

  publishPresence() {
    return this.channel?.track(this.presencePayload())
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
