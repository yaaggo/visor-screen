// Monta o MediaStream a transmitir: tela/janela (navegador ou desktop) ou dispositivo de video.
import { desktop } from './env.js'
import { videoConstraints } from './quality.js'
import { AppAudioMixer } from './appAudio.js'
import { captureNative } from './nativeCapture.js'

const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 }

// Amplifica uma track de audio de navegador/dispositivo com GainNode + limiter suave anti-clipping
function createStreamAudioBooster(rawStream, initialGain = 1) {
  const [rawAudio] = rawStream.getAudioTracks()
  if (!rawAudio) return { stream: rawStream, setGain: () => {}, cleanup: () => {} }
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
  const src = ctx.createMediaStreamSource(new MediaStream([rawAudio]))
  const gainNode = ctx.createGain()
  gainNode.gain.value = initialGain
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -1.5
  limiter.knee.value = 6
  limiter.ratio.value = 12
  limiter.attack.value = 0.003
  limiter.release.value = 0.15
  const dest = ctx.createMediaStreamDestination()
  dest.channelCount = 2
  src.connect(gainNode)
  gainNode.connect(limiter)
  limiter.connect(dest)
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  const [boostedAudio] = dest.stream.getAudioTracks()
  boostedAudio.contentHint = 'music'
  const stream = new MediaStream([...rawStream.getVideoTracks(), boostedAudio])
  return {
    stream,
    setGain: (v) => gainNode.gain.setTargetAtTime(Math.max(0, Math.min(4, Number(v) || 0)), ctx.currentTime, 0.015),
    cleanup: () => {
      rawAudio.stop()
      boostedAudio.stop()
      ctx.close().catch(() => {})
    },
  }
}

// Navegador: seletor do proprio navegador. Audio = aba/sistema (o navegador decide o que oferece).
export async function captureWeb(surface, preset, withAudio, audioGain = 1) {
  const rawStream = await navigator.mediaDevices.getDisplayMedia({
    video: { ...videoConstraints(preset), displaySurface: surface },
    audio: withAudio ? { ...RAW_AUDIO, suppressLocalAudioPlayback: false } : false,
    systemAudio: withAudio ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: surface === 'monitor' ? 'include' : 'exclude',
  })
  const boosted = createStreamAudioBooster(rawStream, audioGain)
  return { stream: boosted.stream, setAudioGain: boosted.setGain, cleanup: boosted.cleanup }
}

// Desktop: fonte escolhida no seletor proprio + mixer de audio por app.
function captureChromium(sourceId, preset) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: preset.width,
        maxHeight: preset.height,
        maxFrameRate: preset.fps,
        minFrameRate: Math.min(30, preset.fps),
      },
    },
  })
}

export async function captureDesktop(sourceId, preset, audioTargets, engine = 'chromium', audioGain = 1) {
  const native = engine === 'rust' ? await captureNative(sourceId, preset) : null
  const video = native?.track ?? (await captureChromium(sourceId, preset)).getVideoTracks()[0]
  const mixer = new AppAudioMixer(audioGain)
  try {
    await mixer.set(audioTargets)
  } catch (error) {
    native?.stop()
    video.stop()
    mixer.close()
    throw error
  }
  const stream = new MediaStream([video, mixer.track])
  return {
    stream,
    mixer,
    setAudioGain: (v) => mixer.setGain(v),
    engine,
    setPreset: native?.setPreset,
    getStats: native?.getStats,
    cleanup: () => {
      native?.stop()
      mixer.close()
    },
  }
}

// Placa de captura / webcam + (opcional) entrada de audio do proprio dispositivo.
export async function captureDevice(deviceId, preset, audioDeviceId, audioGain = 1) {
  const rawStream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId }, ...videoConstraints(preset) },
    audio: audioDeviceId ? { deviceId: { exact: audioDeviceId }, ...RAW_AUDIO } : false,
  })
  rawStream.getAudioTracks().forEach((t) => (t.contentHint = 'music'))
  const boosted = createStreamAudioBooster(rawStream, audioGain)
  return { stream: boosted.stream, setAudioGain: boosted.setGain, cleanup: boosted.cleanup }
}

// Lista dispositivos; pede permissao uma vez se os nomes vierem vazios.
export async function listDevices() {
  let all = await navigator.mediaDevices.enumerateDevices()
  if (all.some((d) => d.kind === 'videoinput' && !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      s.getTracks().forEach((t) => t.stop())
    } catch {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true })
        s.getTracks().forEach((t) => t.stop())
      } catch {
        /* sem permissao */
      }
    }
    all = await navigator.mediaDevices.enumerateDevices()
  }
  const clean = (l) => l.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
  return {
    video: all.filter((d) => d.kind === 'videoinput').map((d) => ({ id: d.deviceId, label: clean(d.label) || 'Video' })),
    audio: all
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ id: d.deviceId, label: clean(d.label) || 'Audio' })),
  }
}

// Sugere a entrada de audio que pertence a mesma placa (nome parecido)
export function matchAudio(videoLabel, audios) {
  const words = videoLabel.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)
  let best = null
  let score = 0
  for (const a of audios) {
    const s = words.filter((w) => a.label.toLowerCase().includes(w)).length
    if (s > score) {
      score = s
      best = a
    }
  }
  return best?.id ?? null
}

export const isDesktop = desktop
