// Visor desktop (Electron). Carrega o build web (dist/) e adiciona:
// seletor nativo de tela/janela, captura de audio por aplicativo e permissoes de midia.
const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, shell } = require('electron')
const path = require('node:path')
const audio = require('./audio.cjs')
const registerCapture = require('./capture.cjs')

const DEV_URL = process.env.VISOR_DEV_URL // ex.: http://localhost:5173
const MEDIA_PERMS = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'])

// Prioriza fluidez da transmissao mesmo com a janela em segundo plano
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

// Builds de teste usam perfis separados do Visor instalado.
if (DEV_URL) app.setPath('userData', path.join(app.getPath('appData'), 'visor-screen-dev'))
else {
  if (app.getVersion().includes('-beta.')) app.setPath('userData', path.join(app.getPath('appData'), 'visor-screen-beta'))
  if (!app.requestSingleInstanceLock()) app.quit()
}

let win = null
let priorityQueue = Promise.resolve()
let priorityRequested = false
let stopCapture = () => {}

function setStreamingPriority(enabled) {
  if (enabled === priorityRequested) return priorityQueue
  priorityRequested = enabled
  priorityQueue = priorityQueue.then(() => audio.boost(enabled)).catch((err) => {
    console.warn('[visor] streaming priority:', err.message)
    return null
  })
  return priorityQueue
}

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
  win.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    // Miniplayer: janela em branco aberta pelo proprio app (o React desenha nela o video da transmissao).
    // Sem moldura e sempre no topo, inclusive sobre jogos em tela cheia sem borda.
    if (frameName === 'visor-mini' && url === 'about:blank') {
      const size = Object.fromEntries(features.split(',').map(f => f.split('=')).map(([k, v]) => [k.trim(), Number(v)]))
      const width = Math.max(240, Math.min(960, size.width || 420)), height = Math.max(135, Math.min(720, size.height || 236))
      const area = screen.getDisplayMatching(win.getBounds()).workArea
      return { action: 'allow', overrideBrowserWindowOptions: {
        width, height, x: area.x + area.width - width - 24, y: area.y + area.height - height - 24,
        minWidth: 240, minHeight: 135, frame: false, alwaysOnTop: true, maximizable: false, fullscreenable: false,
        backgroundColor: '#050505', title: 'Visor', autoHideMenuBar: true, roundedCorners: true, icon: path.join(__dirname, 'icon.png'),
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
      } }
    }
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('did-create-window', child => {
    child.setAlwaysOnTop(true, 'screen-saver')
    child.webContents.on('will-navigate', e => e.preventDefault())
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return
    if (!url.startsWith('file:')) e.preventDefault()
  })

  // Zoom: o atalho Ctrl+Plus do menu padrao nao dispara no teclado ABNT2 ('+' fica no '=' com Shift),
  // entao quem diminuia o zoom ficava preso. Trata Ctrl + '=' / '+' / '-' / '0' (e teclado numerico) e Ctrl + roda.
  const ZOOM_MIN = -3, ZOOM_MAX = 4
  const zoomBy = step => {
    const wc = win.webContents
    wc.setZoomLevel(step === 0 ? 0 : Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, wc.getZoomLevel() + step)))
  }
  win.webContents.on('before-input-event', (event, input) => {
    // Alt sozinho nao abre o menu escondido (Alt+clique e o ping na transmissao).
    if (input.key === 'Alt' && !input.control && !input.shift && !input.meta) return event.preventDefault()
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
    const k = input.key, c = input.code
    if (k === '=' || k === '+' || c === 'NumpadAdd' || c === 'Equal') zoomBy(0.5)
    else if (k === '-' || k === '_' || c === 'NumpadSubtract' || c === 'Minus') zoomBy(-0.5)
    else if ((k === '0' || c === 'Numpad0' || c === 'Digit0') && !input.shift) zoomBy(0)
    else return
    event.preventDefault()
  })
  win.webContents.on('zoom-changed', (_e, direction) => zoomBy(direction === 'in' ? 0.5 : -0.5))

  // Mensagem nova com a janela sem foco: pisca na barra de tarefas ate o usuario voltar.
  ipcMain.removeAllListeners('attention')
  ipcMain.on('attention', event => { if (event.sender === win.webContents && !win.isFocused()) win.flashFrame(true) })
  win.on('focus', () => win.flashFrame(false))

  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  win.webContents.on('render-process-gone', () => {
    stopCapture()
    setStreamingPriority(false)
  })
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      stopCapture()
      setStreamingPriority(false)
    }
  })
  win.on('closed', () => {
    audio.stopAll()
    stopCapture()
    setStreamingPriority(false)
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
  require('./updates.cjs').registerUpdates(app, ipcMain, () => win)
  stopCapture = registerCapture(() => win)
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
  ipcMain.handle('boost', (e, on) => {
    if (e.sender !== win?.webContents || e.senderFrame !== e.sender.mainFrame || typeof on !== 'boolean') return null
    return setStreamingPriority(on)
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
