// Imports the GPU frames already transferred by the isolated Electron preload.
// The regular ScreenRoom sends the resulting track to browser viewers.
const bridge = Symbol.for('visor.captureReceivers')
const receivers = window[bridge] ?? new Map()
if (window.visor?.captureAvailable && !window[bridge]) {
  window[bridge] = receivers
  window.addEventListener('message', ({ source, data }) => {
    if (source !== window || data?.type !== 'visor:capture:frame' || !(data.frame instanceof VideoFrame)) return
    const receiver = receivers.get(data.id)
    if (receiver) receiver(data.frame)
    else data.frame.close()
  })
}

export async function captureNative(sourceId, preset) {
  const id = crypto.randomUUID()
  const generator = new MediaStreamTrackGenerator({ kind: 'video' })
  const writer = generator.writable.getWriter()
  let closed = false
  let stats = null
  let pending = null
  let writing = false
  let writerDrops = 0
  let resolveFirst, rejectFirst
  const firstFrame = new Promise((resolve, reject) => {
    resolveFirst = resolve
    rejectFirst = reject
  })
  const timeout = setTimeout(() => rejectFirst(new Error('A captura nativa não entregou quadros')), 6500)

  function end(error) {
    if (closed) return
    rejectFirst(error)
    close()
    generator.dispatchEvent(new Event('ended'))
  }

  function writeLatest() {
    if (closed || !pending || writing) return
    const frame = pending
    pending = null
    writing = true
    writer.write(frame).then(resolveFirst, end).finally(() => {
      frame.close()
      writing = false
      writeLatest()
    })
  }

  const onFrame = (frame) => {
    if (closed || frame.codedWidth === 0) {
      frame.close()
      return
    }
    if (pending) {
      pending.close()
      writerDrops++
    }
    pending = frame
    writeLatest()
  }
  const offEnd = window.visor.onCaptureEnd((session, message) => {
    if (session === id) end(new Error(message || 'A fonte de captura foi fechada'))
  })
  const offStats = window.visor.onCaptureStats((session, sample) => {
    if (session === id) {
      stats = { ...sample, writerDrops }
      writerDrops = 0
    }
  })

  function close() {
    if (closed) return
    closed = true
    clearTimeout(timeout)
    receivers.delete(id)
    offEnd()
    offStats()
    pending?.close()
    pending = null
    generator.stop()
    writer.abort().catch(() => {})
    window.visor.captureStop(id).catch(() => {})
  }

  receivers.set(id, onFrame)
  try {
    await Promise.all([window.visor.captureStart(id, sourceId, preset), firstFrame])
  } catch (error) {
    close()
    throw error
  } finally {
    clearTimeout(timeout)
  }

  return {
    track: generator,
    stop: close,
    setPreset: (next) => window.visor.capturePreset(id, next),
    getStats: () => stats,
  }
}
