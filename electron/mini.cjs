// Miniplayer do desktop: janela transparente sem moldura, sempre no topo, aberta pelo app com window.open('visor-mini')
// (o React desenha nela o video da transmissao, sem copiar o stream). Este modulo move e redimensiona a janela:
// - follow: a janela segue o cursor (arrastar a transmissao para fora do app, ou arrastar o proprio miniplayer);
//   enquanto segue, avisa o app onde o cursor esta e se esta sobre a janela principal (para virar carta);
// - resize: muda o tamanho com animacao (carta <-> player, roda do mouse), mantendo um ponto fixo;
// - unfollow: solta; a janela fica inteira na tela e gruda nas bordas quando perto delas.
// Tamanhos e posicoes sao do conteudo; a janela tem MARGIN em volta para a sombra.
const { ipcMain, screen } = require('electron')

const MARGIN = 12
const SNAP = 44 // distancia da borda da area de trabalho que gruda
const GAP = 16 // folga da borda depois de grudar
const MIN_W = 72, MAX_W = 1280

function setupMini(getWindow) {
  let mini = null
  let timer = null
  let cur = null // { x, y, w, h } conteudo atual
  let size = null // { w, h } tamanho alvo
  let follow = null // { fx, fy, tfx, tfy } ponto agarrado (fracao do conteudo)
  let anchor = null // { ax, ay, px, py, gx, gy } ponto fixo enquanto o tamanho anima (gx/gy = alvo do ponto)
  let lastCursor = ''

  const own = e => e.sender === getWindow()?.webContents
  const alive = () => mini && !mini.isDestroyed()
  const workAt = (x, y) => screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea
  const clampSize = s => ({ w: Math.max(MIN_W, Math.min(MAX_W, s.w)), h: Math.max(MIN_W * .5, Math.min(MAX_W, s.h)) })

  function apply() {
    if (!alive()) return
    mini.setBounds({ x: Math.round(cur.x - MARGIN), y: Math.round(cur.y - MARGIN), width: Math.round(cur.w + MARGIN * 2), height: Math.round(cur.h + MARGIN * 2) })
  }
  // Dentro da area de trabalho do monitor (com folga), para o player nunca ficar cortado.
  function clampInto(x, y, w, h) {
    const a = workAt(x + w / 2, y + h / 2)
    return { x: Math.max(a.x + 4, Math.min(a.x + a.width - w - 4, x)), y: Math.max(a.y + 4, Math.min(a.y + a.height - h - 4, y)) }
  }

  function tick() {
    if (!alive() || !cur) return stop()
    const k = .3
    let busy = false
    if (size) {
      cur.w += (size.w - cur.w) * k; cur.h += (size.h - cur.h) * k
      if (Math.abs(size.w - cur.w) < .5 && Math.abs(size.h - cur.h) < .5) { cur.w = size.w; cur.h = size.h; size = null } else busy = true
    }
    if (follow) {
      follow.fx += (follow.tfx - follow.fx) * k; follow.fy += (follow.tfy - follow.fy) * k
      const c = screen.getCursorScreenPoint()
      cur.x = c.x - follow.fx * cur.w; cur.y = c.y - follow.fy * cur.h
      report(c)
      busy = true
    } else if (anchor) {
      anchor.px += (anchor.gx - anchor.px) * k; anchor.py += (anchor.gy - anchor.py) * k
      const p = clampInto(anchor.px - anchor.ax * cur.w, anchor.py - anchor.ay * cur.h, cur.w, cur.h)
      cur.x = p.x; cur.y = p.y
      if (Math.abs(anchor.gx - anchor.px) > .5 || Math.abs(anchor.gy - anchor.py) > .5) busy = true
    }
    apply()
    if (!busy) stop()
  }
  function start() { if (!timer) timer = setInterval(tick, 8) }
  function stop() { clearInterval(timer); timer = null }

  // Cursor em coordenadas da pagina da janela principal (com zoom) e se esta sobre ela.
  function report(c) {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    const b = win.getContentBounds(), z = win.webContents.getZoomFactor() || 1
    const inside = win.isVisible() && !win.isMinimized() && c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height
    const msg = { x: Math.round((c.x - b.x) / z), y: Math.round((c.y - b.y) / z), inside }
    const key = msg.x + ',' + msg.y + ',' + inside
    if (key === lastCursor) return
    lastCursor = key
    win.webContents.send('mini:cursor', msg)
  }

  // Ponto fixo para animar o tamanho: o canto mais perto do canto da tela (o player cresce para dentro).
  function cornerAnchor() {
    const a = workAt(cur.x + cur.w / 2, cur.y + cur.h / 2)
    const ax = cur.x + cur.w / 2 < a.x + a.width / 2 ? 0 : 1, ay = cur.y + cur.h / 2 < a.y + a.height / 2 ? 0 : 1
    const px = cur.x + ax * cur.w, py = cur.y + ay * cur.h
    return { ax, ay, px, py, gx: px, gy: py }
  }

  ipcMain.on('mini:show', e => { if (own(e) && alive()) { if (cur) apply(); mini.showInactive(); mini.setAlwaysOnTop(true, 'screen-saver') } })
  ipcMain.on('mini:hide', e => { if (own(e) && alive()) { follow = null; mini.hide() } })
  // Posiciona o conteudo (atCursor: centrado no cursor), sem animacao.
  ipcMain.on('mini:place', (e, r) => {
    if (!own(e) || !alive()) return
    const s = clampSize(r)
    let x = r.x, y = r.y
    if (r.atCursor) { const c = screen.getCursorScreenPoint(); x = c.x - s.w / 2; y = c.y - s.h / 2 }
    const p = clampInto(x, y, s.w, s.h)
    cur = { x: p.x, y: p.y, w: s.w, h: s.h }
    size = null; follow = null; anchor = null
    apply()
  })
  // Segue o cursor; w/h (opcional) anima o tamanho; jump: comeca ja no tamanho e no ponto (sem deslizar).
  ipcMain.on('mini:follow', (e, o = {}) => {
    if (!own(e) || !alive()) return
    const c = screen.getCursorScreenPoint()
    const fx = o.fx ?? follow?.tfx ?? .5, fy = o.fy ?? follow?.tfy ?? .5
    if (o.w && o.h) {
      const s = clampSize(o)
      if (o.jump || !cur) cur = { x: c.x - fx * s.w, y: c.y - fy * s.h, w: s.w, h: s.h }
      else size = s
    }
    if (!cur) return
    follow = o.jump || !follow ? { fx, fy, tfx: fx, tfy: fy } : { ...follow, tfx: fx, tfy: fy }
    anchor = null
    lastCursor = ''
    tick(); start()
  })
  // Solta: o ponto agarrado fica parado; se a janela ficaria cortada ou perto da borda, desliza para dentro e gruda.
  ipcMain.handle('mini:unfollow', e => {
    if (!own(e) || !alive() || !cur) return null
    const f = follow ?? { fx: .5, fy: .5 }
    follow = null
    const c = screen.getCursorScreenPoint()
    const w = size?.w ?? cur.w, h = size?.h ?? cur.h
    anchor = { ax: f.fx, ay: f.fy, px: c.x, py: c.y, gx: c.x, gy: c.y }
    settle(w, h)
    start()
    return { x: cur.x, y: cur.y, w, h }
  })
  function settle(w, h) {
    const x = anchor.gx - anchor.ax * w, y = anchor.gy - anchor.ay * h
    const a = workAt(x + w / 2, y + h / 2)
    let nx = Math.max(a.x + GAP, Math.min(a.x + a.width - w - GAP, x)), ny = Math.max(a.y + GAP, Math.min(a.y + a.height - h - GAP, y))
    if (nx - a.x < SNAP + GAP) nx = a.x + GAP
    if (a.x + a.width - (nx + w) < SNAP + GAP) nx = a.x + a.width - w - GAP
    if (ny - a.y < SNAP + GAP) ny = a.y + GAP
    if (a.y + a.height - (ny + h) < SNAP + GAP) ny = a.y + a.height - h - GAP
    anchor.gx = nx + anchor.ax * w; anchor.gy = ny + anchor.ay * h
  }
  // Novo tamanho com animacao. anchor: 'grab' (ponto onde foi solto), 'corner' (canto perto da borda) ou 'center'.
  ipcMain.on('mini:resize', (e, o) => {
    if (!own(e) || !alive() || !cur) return
    size = clampSize(o)
    if (!follow) {
      if (o.anchor === 'corner') anchor = cornerAnchor()
      else if (o.anchor === 'center' || !anchor) { const px = cur.x + cur.w / 2, py = cur.y + cur.h / 2; anchor = { ax: .5, ay: .5, px, py, gx: px, gy: py } }
      settle(size.w, size.h)
    }
    start()
  })

  return {
    margin: MARGIN,
    // Opcoes da janela (setWindowOpenHandler): escondida ate o app posicionar e mostrar.
    options: icon => ({
      show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false,
      maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: true,
      width: 200, height: 200, title: 'Visor', autoHideMenuBar: true, icon,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    }),
    attach(child) {
      mini = child
      cur = null; size = null; follow = null; anchor = null
      child.setAlwaysOnTop(true, 'screen-saver')
      child.on('closed', () => { if (mini === child) { mini = null; stop() } })
    },
    close() { if (alive()) mini.close() },
  }
}

module.exports = { setupMini }
