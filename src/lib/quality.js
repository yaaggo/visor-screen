// Presets de resolucao/fps. Teto: 1080p 60 fps.
export const PRESETS = [
  { id: '1080p60', res: '1080', fps: 60, width: 1920, height: 1080, bitrate: 25_000_000 },
  { id: '1080p30', res: '1080', fps: 30, width: 1920, height: 1080, bitrate: 8_000_000 },
  { id: '720p60', res: '720', fps: 60, width: 1280, height: 720, bitrate: 6_000_000 },
  { id: '720p30', res: '720', fps: 30, width: 1280, height: 720, bitrate: 4_000_000 },
  { id: '480p30', res: '480', fps: 30, width: 854, height: 480, bitrate: 2_000_000 },
]
export const DEFAULT_PRESET = '1080p60'
export const getPreset = (id) => PRESETS.find((p) => p.id === id) ?? PRESETS[0]

// Degraus de bitrate (Mbps). Teto de 50 Mbps: ver AGENTS.md > "Analise de bitrate".
export const BITRATES = [2, 3, 4, 6, 8, 10, 12, 16, 20, 25, 30, 40, 50].map((m) => m * 1_000_000)
export const MAX_BITRATE = BITRATES[BITRATES.length - 1]
export const AUDIO_BITRATE = 256_000

export const snapBitrate = (bps) => BITRATES.reduce((best, b) => (b <= bps ? b : best), BITRATES[0])
export const fmtMbps = (bps) => (bps >= 10e6 ? Math.round(bps / 1e6) : Math.round(bps / 1e5) / 10) + 'M'

export function videoConstraints(preset) {
  return {
    width: { ideal: preset.width, max: preset.width },
    height: { ideal: preset.height, max: preset.height },
    frameRate: { ideal: preset.fps, max: preset.fps },
  }
}

// Aplica bitrate/fps maximos e preferencia de degradacao em um sender de video
export async function tuneSender(sender, preset, bitrate, keepResolution = true) {
  const params = sender.getParameters()
  if (!params.encodings?.length) params.encodings = [{}]
  const enc = params.encodings[0]
  if (sender.track?.kind === 'audio') {
    enc.maxBitrate = AUDIO_BITRATE
    enc.priority = 'high'
    enc.networkPriority = 'high'
  } else {
    enc.maxBitrate = bitrate
    enc.maxFramerate = preset.fps
    enc.scaleResolutionDownBy = 1
    enc.priority = 'high'
    enc.networkPriority = 'high'
    params.degradationPreference = keepResolution ? 'maintain-resolution' : 'maintain-framerate'
  }
  try {
    await sender.setParameters(params)
  } catch {
    delete params.degradationPreference
    await sender.setParameters(params).catch(() => {})
  }
}

// Camera junto com a tela: teto baixo e prioridade abaixo da tela, para nao roubar banda do jogo.
export const CAMERA_BITRATE = 900_000
export async function tuneCamera(sender) {
  if (!sender?.track) return
  const params = sender.getParameters()
  if (!params.encodings?.length) params.encodings = [{}]
  Object.assign(params.encodings[0], { maxBitrate: CAMERA_BITRATE, maxFramerate: 30, scaleResolutionDownBy: 1, priority: 'low', networkPriority: 'low' })
  params.degradationPreference = 'balanced'
  try { await sender.setParameters(params) } catch {
    delete params.degradationPreference
    await sender.setParameters(params).catch(() => {})
  }
}

// Ajusta a SDP de resposta recebida pelo transmissor:
// - video: libera BWE ate MAX_BITRATE e comeca alto (x-google-*)
// - audio: Opus estereo, 256 kbps, sem DTX
export function mungeAnswer(sdp, bitrate) {
  const start = Math.round(Math.min(bitrate, MAX_BITRATE) / 1000)
  const min = Math.max(500, Math.min(4000, Math.round(start * 0.25)))
  const lines = sdp.split('\r\n')
  const opus = new Set()
  const video = new Set()
  let section = ''
  for (const l of lines) {
    if (l.startsWith('m=')) section = l.slice(2, 7)
    const m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//)
    if (!m) continue
    if (section === 'audio' && m[2].toLowerCase() === 'opus') opus.add(m[1])
    if (section === 'video' && !/rtx|red|ulpfec|flexfec/i.test(m[2])) video.add(m[1])
  }
  const hasConfig = new Set(lines.flatMap(l => l.match(/^a=fmtp:(\d+) /)?.slice(1) ?? []))
  const hints = `x-google-start-bitrate=${start};x-google-max-bitrate=${MAX_BITRATE / 1000};x-google-min-bitrate=${min}`
  const out = lines.map((l) => {
    const codec = l.match(/^a=rtpmap:(\d+) /)?.[1]
    if (video.has(codec) && !hasConfig.has(codec)) return l + '\r\na=fmtp:' + codec + ' ' + hints
    const m = l.match(/^a=fmtp:(\d+) (.*)$/)
    if (!m) return l
    const [, pt, cfg] = m
    if (opus.has(pt)) {
      const keep = cfg.split(';').filter((p) => !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx|cbr)=/.test(p))
      return `a=fmtp:${pt} ${[...keep, 'stereo=1', 'sprop-stereo=1', `maxaveragebitrate=${AUDIO_BITRATE}`, 'usedtx=0'].join(';')}`
    }
    if (video.has(pt)) {
      const keep = cfg.split(';').filter(p => !/^\s*x-google-(start|min|max)-bitrate=/i.test(p))
      return `a=fmtp:${pt} ${[...keep, hints].join(';')}`
    }
    return l
  })
  return out.join('\r\n')
}
