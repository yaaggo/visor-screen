// Monta o MediaStream a transmitir: tela/janela (navegador ou desktop) ou dispositivo de video.
import { desktop } from './env.js'
import { videoConstraints } from './quality.js'
import { AppAudioMixer } from './appAudio.js'

const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 }

// Navegador: seletor do proprio navegador. Audio = aba/sistema (o navegador decide o que oferece).
export async function captureWeb(surface, preset, withAudio) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { ...videoConstraints(preset), displaySurface: surface },
    audio: withAudio ? { ...RAW_AUDIO, suppressLocalAudioPlayback: false } : false,
    systemAudio: withAudio ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: surface === 'monitor' ? 'include' : 'exclude',
  })
  return { stream, cleanup: () => {} }
}

// Desktop: fonte escolhida no seletor proprio + mixer de audio por app.
export async function captureDesktop(sourceId, preset, audioTargets) {
  const video = await navigator.mediaDevices.getUserMedia({
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
  const mixer = new AppAudioMixer()
  try {
    await mixer.set(audioTargets)
  } catch (error) {
    video.getTracks().forEach((track) => track.stop())
    mixer.close()
    throw error
  }
  const stream = new MediaStream([...video.getVideoTracks(), mixer.track])
  return { stream, mixer, cleanup: () => mixer.close() }
}

// Placa de captura / webcam + (opcional) entrada de audio do proprio dispositivo.
export async function captureDevice(deviceId, preset, audioDeviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId }, ...videoConstraints(preset) },
    audio: audioDeviceId ? { deviceId: { exact: audioDeviceId }, ...RAW_AUDIO } : false,
  })
  stream.getAudioTracks().forEach((t) => (t.contentHint = 'music'))
  return { stream, cleanup: () => {} }
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
