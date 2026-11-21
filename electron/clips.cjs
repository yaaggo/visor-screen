// Clipes de replay (F9): pasta propria em Videos\Visor Clips, atalho global so enquanto o replay esta armado.
// Cada clipe = <nome>.webm + <nome>.jpg (miniatura) + <nome>.json (duracao, origem). Nomes sempre via basename.
const { app, globalShortcut, ipcMain, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const VIDEO = /\.(webm|mp4)$/i
function folder() {
  const dir = path.join(app.getPath('videos'), 'Visor Clips')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const inFolder = name => path.join(folder(), path.basename(String(name)))
const stem = file => file.replace(VIDEO, '')
const stamp = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
  ' ' + String(d.getHours()).padStart(2, '0') + '-' + String(d.getMinutes()).padStart(2, '0') + '-' + String(d.getSeconds()).padStart(2, '0')

function setupClips(getWindow) {
  const own = event => event.sender === getWindow()?.webContents

  ipcMain.handle('clips:save', async (event, { data, thumb, meta, ext }) => {
    if (!own(event) || !(data instanceof Uint8Array || data instanceof ArrayBuffer)) return null
    let base = 'Visor ' + stamp(new Date()), n = 1
    while (fs.existsSync(inFolder(base + '.webm')) || fs.existsSync(inFolder(base + '.mp4'))) base = 'Visor ' + stamp(new Date()) + ' (' + ++n + ')'
    const file = base + (ext === 'mp4' ? '.mp4' : '.webm')
    await fs.promises.writeFile(inFolder(file), Buffer.from(data))
    if (typeof thumb === 'string' && thumb.startsWith('data:image/jpeg;base64,'))
      await fs.promises.writeFile(inFolder(base + '.jpg'), Buffer.from(thumb.slice(23), 'base64'))
    await fs.promises.writeFile(inFolder(base + '.json'), JSON.stringify({ ...(meta ?? {}), createdAt: Date.now() }))
    return { name: file }
  })

  ipcMain.handle('clips:list', async event => {
    if (!own(event)) return []
    const dir = folder()
    const files = (await fs.promises.readdir(dir)).filter(f => VIDEO.test(f))
    const clips = await Promise.all(files.map(async name => {
      const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null)
      if (!stat) return null
      const meta = await fs.promises.readFile(path.join(dir, stem(name) + '.json'), 'utf8').then(JSON.parse).catch(() => ({}))
      const thumb = await fs.promises.readFile(path.join(dir, stem(name) + '.jpg')).then(b => 'data:image/jpeg;base64,' + b.toString('base64')).catch(() => null)
      return { name, size: stat.size, createdAt: meta.createdAt ?? stat.mtimeMs, duration: meta.duration ?? null, source: meta.source ?? null, thumb }
    }))
    return clips.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt)
  })

  ipcMain.handle('clips:read', async (event, name) => own(event) && VIDEO.test(name) ? fs.promises.readFile(inFolder(name)) : null)
  ipcMain.handle('clips:folder', event => own(event) ? shell.openPath(folder()) : null)
  ipcMain.handle('clips:reveal', (event, name) => { if (own(event) && VIDEO.test(name)) shell.showItemInFolder(inFolder(name)) })
  // Apagar = mandar para a Lixeira (recuperavel), com a miniatura e os dados juntos.
  ipcMain.handle('clips:remove', async (event, name) => {
    if (!own(event) || !VIDEO.test(name)) return false
    for (const file of [path.basename(name), stem(path.basename(name)) + '.jpg', stem(path.basename(name)) + '.json'])
      if (fs.existsSync(inFolder(file))) await shell.trashItem(inFolder(file)).catch(() => {})
    return true
  })

  // F9 global (funciona com o jogo em foco) so enquanto alguem transmite com o replay ligado.
  ipcMain.handle('replay:arm', (event, on) => {
    if (!own(event)) return false
    globalShortcut.unregister('F9')
    if (!on) return true
    return globalShortcut.register('F9', () => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('replay:save') })
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
}

module.exports = { setupClips }
