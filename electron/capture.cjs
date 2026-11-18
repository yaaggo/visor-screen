const { app, desktopCapturer, ipcMain, screen, sharedTexture } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')
const { createInterface } = require('node:readline')

const binary = () => app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'visor-capture.exe')
  : path.join(__dirname, 'capture-rs', 'target', 'release', 'visor-capture.exe')

const max = { width: 1920, height: 1080, fps: 60 }
const presetArgs = (preset) => Object.keys(max).map((key) => {
  const value = preset?.[key]
  if (!Number.isInteger(value) || value < 1 || value > max[key]) throw new Error('Preset inválido')
  return String(value)
})

async function targetFor(id) {
  if (typeof id !== 'string' || !/^(screen|window):\d+:\d+$/.test(id)) throw new Error('Fonte inválida')
  const kind = id.startsWith('screen:') ? 'screen' : 'window'
  const sources = await desktopCapturer.getSources({ types: [kind], thumbnailSize: { width: 0, height: 0 } })
  const source = sources.find((entry) => entry.id === id)
  if (!source) throw new Error('Fonte indisponível')
  if (kind === 'window') return ['window', source.id.split(':')[1]]

  const display = screen.getAllDisplays().find((entry) => String(entry.id) === source.display_id)
  if (!display) throw new Error('Monitor indisponível')
  const { x, y, width, height } = display.bounds
  const point = screen.dipToScreenPoint({ x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) })
  return ['monitor', `${point.x},${point.y}`]
}

function alive(session) {
  return !session.stopped && !session.contents.isDestroyed() && !session.frame.isDestroyed()
}

function send(session, channel, data) {
  if (alive(session)) session.frame.send(channel, session.id, data)
}

function command(session, text) {
  if (session.child?.stdin.writable) session.child.stdin.write(text + '\n')
}

async function forward(session, data) {
  const { slot, handle, timestamp, width, height } = data
  const ntHandle = Buffer.alloc(8)
  ntHandle.writeBigUInt64LE(BigInt('0x' + handle))
  const imported = sharedTexture.importSharedTexture({
    textureInfo: {
      pixelFormat: 'bgra',
      codedSize: { width, height },
      visibleRect: { x: 0, y: 0, width, height },
      timestamp,
      handle: { ntHandle },
    },
    allReferencesReleased: () => {
      if (!session.stopped) command(session, `release ${slot}`)
    },
  })
  try {
    await sharedTexture.sendSharedTexture({ frame: session.frame, importedSharedTexture: imported }, session.id)
  } finally {
    imported.release()
  }
}

function supported() {
  return process.platform === 'win32' && Boolean(sharedTexture?.importSharedTexture) && existsSync(binary())
}

module.exports = function registerCapture(getWindow) {
  let active = null
  const trusted = (event) => event.sender === getWindow()?.webContents && event.senderFrame === event.sender.mainFrame

  function stop(session = active) {
    if (!session || session.stopped) return
    session.stopped = true
    if (active === session) active = null
    command(session, 'stop')
    session.child?.stdin.end()
    if (session.child) {
      const timer = setTimeout(() => session.child.kill(), 1500)
      timer.unref()
      session.child.once('close', () => clearTimeout(timer))
    }
  }

  function end(session, error) {
    if (!alive(session)) return
    if (error) console.warn('[visor-capture]', error)
    try {
      send(session, 'capture:ended', error ? 'Falha na captura nativa' : null)
    } finally {
      stop(session)
    }
  }

  async function forwardLatest(session) {
    session.forwarding = true
    try {
      while (alive(session) && session.pending) {
        const data = session.pending
        session.pending = null
        await forward(session, data)
      }
    } catch (error) {
      end(session, error.message)
    } finally {
      session.forwarding = false
    }
  }

  ipcMain.handle('capture:available', (event) => trusted(event) && supported())
  ipcMain.handle('capture:start', async (event, id, source, preset) => {
    if (!trusted(event) || !supported()) throw new Error('Captura nativa indisponível')
    if (active || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Captura nativa ocupada')
    const dimensions = presetArgs(preset)
    const session = {
      id, contents: event.sender, frame: event.senderFrame, child: null, stopped: false,
      pending: null, forwarding: false, bridgeDrops: 0,
    }
    active = session
    try {
      const [target, info] = await Promise.all([targetFor(source), app.getGPUInfo('basic')])
      if (!alive(session)) throw new Error('Captura cancelada')
      const gpu = info.gpuDevice?.find((device) => device.active)
      const child = spawn(binary(), [...target, String(process.pid), String(gpu?.vendorId ?? 0), String(gpu?.deviceId ?? 0), ...dimensions], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      session.child = child
      child.stdin.on('error', () => {})
      child.stderr.on('data', (chunk) => console.warn(chunk.toString().trimEnd()))
      child.on('error', (error) => end(session, error.message))
      child.on('close', (code) => end(session, code ? `processo terminou com código ${code}` : null))
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (!alive(session)) return
        try {
          const data = JSON.parse(line)
          if (data.type === 'frame') {
            // Keep the latest frame if the renderer falls behind a texture transfer.
            if (session.pending) {
              command(session, `release ${session.pending.slot}`)
              session.bridgeDrops++
            }
            session.pending = data
            if (!session.forwarding) void forwardLatest(session)
          }
          if (data.type === 'stats') {
            send(session, 'capture:stats', { ...data, bridgeDrops: session.bridgeDrops })
            session.bridgeDrops = 0
          }
        } catch (error) {
          end(session, error.message)
        }
      })
    } catch (error) {
      stop(session)
      throw error
    }
  })

  ipcMain.handle('capture:preset', (event, id, preset) => {
    if (trusted(event) && active?.id === id) command(active, `preset ${presetArgs(preset).join(' ')}`)
  })
  ipcMain.handle('capture:stop', (event, id) => {
    if (trusted(event) && active?.id === id) stop()
  })
  return () => stop()
}
