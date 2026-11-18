const { app, BrowserWindow, desktopCapturer, screen } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const work = path.resolve(__dirname, '..', '..', 'release', 'qa-1080')
mkdirSync(work, { recursive: true })
app.setPath('userData', path.join(work, 'fixture-profile'))

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay()
  const { width, height } = screen.dipToScreenRect(null, display.bounds)
  if (width !== 1920 || height !== 1080) throw new Error(`O monitor principal está em ${width}x${height}.`)
  const window = new BrowserWindow({
    ...display.bounds,
    frame: false,
    fullscreen: true,
    alwaysOnTop: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false },
  })
  await window.loadFile(path.join(__dirname, 'capture-1080.html'), {
    query: { detail: process.argv.includes('--detail') ? '1' : '0', fps: process.argv.includes('--fast') ? '144' : '0', transitions: process.argv.includes('--transitions') ? '1' : '0' },
  })
  window.showInactive()
  // The first native show can be hidden when launched from a test runner.
  window.hide()
  window.showInactive()
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
  const source = sources.find((entry) => entry.display_id === String(display.id))
  if (!source) throw new Error('O seletor do Electron não encontrou o monitor principal.')
  writeFileSync(path.join(work, 'source.json'), JSON.stringify({ id: source.id, width, height, name: source.name }))
}).catch((error) => {
  console.error(error)
  app.exit(1)
})

app.on('window-all-closed', () => app.quit())
