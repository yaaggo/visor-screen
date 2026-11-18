// Gerencia o helper nativo visor-audio.exe (captura de audio por aplicativo no Windows).
const { execFile, spawn } = require('node:child_process')
const path = require('node:path')
const { app } = require('electron')

const exe = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'visor-audio.exe')
    : path.join(__dirname, 'native', 'bin', 'visor-audio.exe')

const supported = process.platform === 'win32'
const captures = new Map() // id -> ChildProcess

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(exe(), args, { windowsHide: true, timeout: 5000, maxBuffer: 4 << 20 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.toString()),
    )
  })
}

async function listApps() {
  if (!supported) return []
  const self = process.execPath.toLowerCase()
  // remove o proprio Visor/Electron (o audio do app roda num processo filho com o mesmo executavel)
  const apps = JSON.parse(await run(['list'])).filter((a) => a.path.toLowerCase() !== self)
  return Promise.all(
    apps.map(async (a) => {
      let icon = null
      try {
        if (a.path) icon = (await app.getFileIcon(a.path, { size: 'normal' })).toDataURL()
      } catch {
        /* sem icone */
      }
      return { ...a, icon }
    }),
  )
}

async function windowPid(hwnd) {
  if (!supported) return 0
  return Number(await run(['winpid', String(hwnd)])) || 0
}

// Inicia captura; envia blocos de float32 intercalados (estereo, 48 kHz) para o renderer.
function start(sender, id, pid, exclude) {
  stop(id)
  if (!supported) return false
  const child = spawn(exe(), ['capture', String(pid), ...(exclude ? ['exclude'] : [])], { windowsHide: true })
  captures.set(id, child)
  let rest = Buffer.alloc(0)
  child.stdout.on('data', (chunk) => {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk
    const usable = buf.length - (buf.length % 8) // 8 bytes = 1 frame estereo float32
    rest = buf.subarray(usable)
    if (usable && !sender.isDestroyed()) sender.send('audio:data', id, buf.subarray(0, usable))
  })
  child.stderr.on('data', (d) => console.warn('[visor-audio]', d.toString().trim()))
  child.on('exit', (code) => {
    if (captures.get(id) === child) captures.delete(id)
    if (!sender.isDestroyed()) sender.send('audio:end', id, code)
  })
  return true
}

function stop(id) {
  const child = captures.get(id)
  if (!child) return
  captures.delete(id)
  child.kill()
}

function stopAll() {
  for (const id of [...captures.keys()]) stop(id)
}

module.exports = { supported, listApps, windowPid, start, stop, stopAll }
