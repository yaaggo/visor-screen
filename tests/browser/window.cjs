const { app, BrowserWindow, session } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const base = process.env.VISOR_QA_URL
app.setPath('userData', process.env.VISOR_QA_PROFILE)
app.commandLine.appendSwitch('mute-audio')

async function run() {
  await app.whenReady()
  const origin = new URL(base).origin
  const files = []
  let blockShell = false
  const shellFile = /\/Shell-[^/]+\.js$/
  session.defaultSession.webRequest.onBeforeRequest((request, done) => {
    const url = new URL(request.url)
    if (url.protocol === 'file:') files.push(url.pathname)
    done({ cancel: (blockShell && shellFile.test(url.pathname))
      || (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && url.origin !== origin) })
  })
  const win = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false } })
  const wc = win.webContents
  const read = expression => wc.executeJavaScript(expression)
  async function until(expression) {
    for (let i = 0; i < 150; i++) {
      if (await read('Boolean(' + expression + ')')) return
      await sleep(80)
    }
    throw new Error('Tempo excedido: ' + expression)
  }
  const fixture = mode => win.loadURL(base + 'tests/browser/fixture.html?mode=' + mode)
  await win.loadFile(path.join(process.env.VISOR_QA_BUILD, 'index.html'))
  await until("document.querySelector('.login')")
  const shellLoaded = () => files.some(name => shellFile.test(name))
  assert.equal(shellLoaded(), false)
  await read("document.querySelector('[autocomplete=username]').focus()")
  await wc.insertText('qa')
  await read("document.querySelector('.pin-input').focus()")
  await wc.insertText('1')
  await read("document.querySelector('.go-btn').click()")
  await until("document.querySelector('.deck-hand')")
  assert.equal(shellLoaded(), true, 'Requisições do build: ' + JSON.stringify(files))
  blockShell = true
  await win.loadFile(path.join(process.env.VISOR_QA_BUILD, 'index.html'))
  await until("document.querySelector('.boot-retry [role=alert]')")
  blockShell = false
  await read("document.querySelector('.boot-retry button').click()")
  await until("document.querySelector('[data-server=local]')")
  await read("document.querySelector('[data-server=local]').click()")
  await until("document.querySelector('[data-table=sala]')")
  await read("document.querySelector('[data-table=sala]').click()")
  await until("document.querySelector('.call-session:not([hidden]) .hand-add')")
  console.log('OK – build file://, login, carregamento sob demanda, sessão, deck e entrada na sala')
  await fixture('recover')
  await until("document.querySelector('.boot-retry')")
  assert.deepEqual(await read('qa.logouts'), [])
  await read('qa.hold = false')
  await until("document.querySelector('.deck-hand')")
  assert.deepEqual(await read('qa.logouts'), [])
  await fixture('revoked')
  await until("document.querySelector('.login')")
  assert.deepEqual(await read('qa.logouts'), ['local'])
  await read("location.hash='/j/convite/sala'")
  await until("document.querySelector('.login-invite')")
  await read("location.hash='/'")
  await until("!document.querySelector('.login-invite')")
  console.log('OK – recuperação automática, revogação, Shell e convite')

  await fixture('chat')
  await until('window.qa?.history && qa.callbacks.INSERT')
  await read("qa.insert(2,'ao vivo'); qa.history(); qa.insert(2,'ao vivo')")
  await until("document.querySelectorAll('.msg p').length === 2")
  const texts = () => read("[...document.querySelectorAll('.msg p')].map(p=>p.textContent)")
  assert.deepEqual(await texts(), ['histórico', 'ao vivo'])
  await read("document.querySelector('.msg-del').click()")
  await until("document.querySelector('.msg [role=status]')")
  assert.deepEqual(await texts(), ['histórico', 'ao vivo'])
  await read("document.querySelector('.msg-del').click()")
  await until("document.querySelectorAll('.msg p').length === 1")
  for (let i = 0; i < 2; i++) {
    await read("document.querySelector('.composer input').focus()")
    await wc.insertText('igual')
    await read("document.querySelector('.send').click()")
  }
  await until('qa.sends.length === 2')
  await read("qa.insert(3,'igual'); qa.insert(4,'igual')")
  await sleep(80)
  assert.deepEqual(await texts(), ['ao vivo', 'igual', 'igual'])
  await read("qa.sends[1](4); qa.sends[0](3)")
  await until("!document.querySelector('.is-temp')")
  assert.deepEqual(await texts(), ['ao vivo', 'igual', 'igual'])
  console.log('OK – histórico, Realtime, exclusão e envios idênticos')

  await win.loadURL(base + '#/deck-teste')
  await until("document.querySelector('.deck-add')")
  wc.debugger.attach('1.3')
  const command = (name, params) => wc.debugger.sendCommand(name, params)
  await command('Emulation.setFocusEmulationEnabled', { enabled: true })
  await command('Emulation.setTouchEmulationEnabled', { enabled: true })
  for (const width of [320, 390, 430]) {
    await command('Emulation.setDeviceMetricsOverride', { mobile: true, width, height: 844, deviceScaleFactor: 1 })
    await read("document.querySelector('.deck-add').focus()")
    await sleep(1150)
    assert.equal(await read(`[...document.querySelectorAll('.deck-card')].every(card=>{
      const r=card.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth
    })`), true, 'Carta fora da tela a ' + width)
    const point = await read(`(()=>{const card=document.querySelector('.deck-add'),label=card.querySelector('.deck-caption'),
      r=label.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2;
      return { x,y,labelWidth:label.clientWidth,textWidth:label.scrollWidth,hit:document.elementFromPoint(x,y)?.className,
        visible:label.scrollWidth<=label.clientWidth && card.contains(document.elementFromPoint(x,y)) }})()`)
    assert.ok(point.visible, 'Rótulo inacessível a ' + width + ': ' + JSON.stringify(point))
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x:point.x, y:point.y }] })
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await until("document.querySelector('.step-choose')")
    await read("document.querySelector('.deck-close').click()")
    await until("document.querySelector('.step-idle')")
  }
  await command('Emulation.clearDeviceMetricsOverride')
  await command('Emulation.setTouchEmulationEnabled', { enabled: false })
  await win.loadURL(base + '#/mesa-teste')
  await until("document.querySelector('.hand-add')")
  await read("document.querySelector('.hand-add').focus(); document.activeElement.click()")
  await until("document.querySelector('.share-sheet')?.contains(document.activeElement)")
  await read("document.querySelector('.share-sheet-head button').click()")
  await until("document.activeElement.matches('.hand-add')")
  console.log('OK – toque e limites em 320/390/430 px, foco do painel')

  const scenario = await fs.readFile(path.join(__dirname,'peers.js'),'utf8')
  const result = await read(scenario)
  assert.ok(result.firstAdvanced && result.secondAdvanced && result.firstPreserved && result.renewed && result.independent, JSON.stringify(result))
  console.log('OK – vídeo WebRTC, recuperação de ICE e desconexão independente')
  win.destroy()
}
const watchdog = setTimeout(() => { console.error('QA excedeu 120 s'); app.exit(1) }, 120000)
run().then(() => { clearTimeout(watchdog); app.quit() }).catch(error => { console.error(error); app.exit(1) })
