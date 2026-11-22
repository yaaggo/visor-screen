// Configuracao do codificador do replay (usada na checagem de suporte e no worker).
export function videoConfig(width, height, fps, bitrate) {
  const area = width * height
  // Nivel H264 pelo tamanho: 4.2 ate 1080p60, 5.1 ate 1600p, 5.2 acima.
  const level = area <= 1920 * 1088 ? '2A' : area <= 2560 * 1600 ? '33' : '34'
  return { codec: 'avc1.6400' + level, width, height, bitrate, framerate: fps, bitrateMode: 'variable',
    latencyMode: 'realtime', hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' } }
}
export const even = n => Math.max(2, Math.round(n) & ~1)
