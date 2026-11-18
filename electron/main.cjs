// Visor desktop (Electron). Carrega o build web (dist/) e adiciona:
// seletor nativo de tela/janela, captura de audio por aplicativo e permissoes de midia.
const { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } = require('electron')
const path = require('node:path')
const audio = require('./audio.cjs')

const DEV_URL = process.env.VISOR_DEV_URL // ex.: http://localhost:5173
const MEDIA_PERMS = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'])

// Prioriza fluidez da transmissao mesmo com a janela em segundo plano
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

// Modo dev usa dados separados e convive com o app instalado aberto
if (DEV_URL) app.setPath('userData', path.join(app.getPath('appData'), 'visor-screen-dev'))
else if (!app.requestSingleInstanceLock()) app.quit()

let win = null

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    title: 'Visor',
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0a0a', symbolColor: '#8b8b8b', height: 56 },
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.once('ready-to-show', () => win.show())

  // Links externos abrem no navegador; navegacao interna bloqueada
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return
    if (!url.startsWith('file:')) e.preventDefault()
  })

  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  win.on('closed', () => {
    audio.stopAll()
    win = null
  })
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(MEDIA_PERMS.has(perm)))
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => MEDIA_PERMS.has(perm))

  ipcMain.handle('sources', async () => {
    const list = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 384, height: 216 },
      fetchWindowIcons: true,
    })
    return Promise.all(
      list
        .filter((s) => !s.name.startsWith('Visor'))
        .map(async (s) => {
          const kind = s.id.startsWith('screen') ? 'screen' : 'window'
          let pid = 0
          if (kind === 'window') pid = await audio.windowPid(s.id.split(':')[1]).catch(() => 0)
          return {
            id: s.id,
            kind,
            name: s.name,
            pid,
            thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
            icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
          }
        }),
    )
  })
  ipcMain.handle('audio:supported', () => audio.supported)
  ipcMain.handle('audio:apps', () => audio.listApps().catch(() => []))
  ipcMain.handle('self-pid', () => process.pid)
  ipcMain.handle('audio:start', (e, id, pid, exclude) => audio.start(e.sender, id, pid, exclude))
  ipcMain.handle('audio:stop', (_e, id) => audio.stop(id))

  createWindow()
})

app.on('window-all-closed', () => {
  audio.stopAll()
  app.quit()
})
