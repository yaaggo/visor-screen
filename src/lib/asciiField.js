// Campo ASCII do deck: uma grade de caracteres em cinza que desenha sinais da tela inicial.
// Mouse = lente e rastro; onda = anel que percorre a grade; arraste = fluxo ate a vaga do centro;
// lixeira = caracteres que embaralham e somem; glyph = texto grande no centro com scramble.
// Canvas 2D com atlas de glifos (um drawImage por celula visivel), 30 fps com interacao e 12 fps parado.
// Para quando a janela perde o foco, quando a aba some ou com pause(true) (transmitindo).

const RAMP = ' .·:-=+*#'
const G = RAMP.length
const LEVELS = 14
const MAX_ALPHA = .62
const CW = 12, CH = 14

function hash(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

// Cobertura do texto por celula: desenha o texto num canvas pequeno e mede a media de cada celula.
function rasterize(text, width, height) {
  const cols = Math.max(1, Math.round(width / CW)), rows = Math.max(1, Math.round(height / CH))
  const s = .5, cw = CW * s, ch = CH * s
  const c = document.createElement('canvas')
  c.width = Math.ceil(cols * cw); c.height = Math.ceil(rows * ch)
  const g = c.getContext('2d', { willReadFrequently: true })
  const font = size => `800 ${size}px system-ui, "Segoe UI", sans-serif`
  let size = c.height * .92
  g.font = font(size)
  const w = g.measureText(text).width
  if (w > c.width * .94) size *= c.width * .94 / w
  g.font = font(size)
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(text, c.width / 2, c.height / 2 + size * .04)
  const data = g.getImageData(0, 0, c.width, c.height).data
  const mask = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) {
    let sum = 0, n = 0
    for (let y = Math.floor(r * ch); y < Math.floor((r + 1) * ch); y++)
      for (let x = Math.floor(col * cw); x < Math.floor((col + 1) * cw); x++) { sum += data[(y * c.width + x) * 4 + 3]; n++ }
    mask[r * cols + col] = n ? sum / n / 255 : 0
  }
  return { mask, cols, rows }
}

// Foto em ASCII: um pixel por celula (o navegador faz a reducao), luminancia com contraste esticado entre os
// percentis 5 e 95 e um quadrado arredondado como contorno. Fora do contorno = -1 (a textura continua).
// Custa um drawImage e um getImageData de poucas centenas de pixels; o resultado fica em cache por URL e tamanho.
const photoCache = new Map()
// cosmic: corpo celeste em fundo preto (capa sem foto): sem contorno e sem esticar o contraste; o que e quase
// preto vira -2 (a textura do campo continua intacta em volta do corpo).
export function photoMask(url, width, height, { cosmic = false } = {}) {
  const cols = Math.max(1, Math.round(width / CW)), rows = Math.max(1, Math.round(height / CH))
  const key = url + '|' + cols + 'x' + rows + (cosmic ? '|c' : '')
  let entry = photoCache.get(key)
  if (!entry) {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.src = url
    entry = { ready: null, promise: img.decode().then(() => {
      const c = document.createElement('canvas')
      c.width = cols; c.height = rows
      const g = c.getContext('2d', { willReadFrequently: true })
      g.imageSmoothingQuality = 'high'
      // Recorte central quadrado (cover), como a foto aparece na carta.
      const side = Math.min(img.naturalWidth, img.naturalHeight)
      g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, cols, rows)
      const data = g.getImageData(0, 0, cols, rows).data
      const lum = new Float32Array(cols * rows)
      const inside = new Uint8Array(cols * rows)
      const pw = cols * CW, ph = rows * CH, rad = Math.min(pw, ph) * .2
      const sample = []
      if (cosmic) {
        const mask = new Float32Array(cols * rows), lum = new Float32Array(cols * rows), body = []
        for (let i = 0; i < mask.length; i++) {
          lum[i] = (data[i * 4] * .2126 + data[i * 4 + 1] * .7152 + data[i * 4 + 2] * .0722) / 255 * data[i * 4 + 3] / 255
          if (lum[i] >= .08) body.push(lum[i])
        }
        // Contraste esticado so dentro do corpo: as faixas e crateras aparecem mesmo num planeta cinza medio.
        body.sort((a, b) => a - b)
        const lo = body[Math.floor(body.length * .05)] ?? .08, hi = body[Math.floor(body.length * .97)] ?? 1
        for (let i = 0; i < mask.length; i++)
          mask[i] = lum[i] < .08 ? -2 : .22 + .78 * Math.pow(Math.min(1, Math.max(0, (lum[i] - lo) / Math.max(.05, hi - lo))), .85)
        entry.ready = { mask, cols, rows }
        return entry.ready
      }
      for (let r = 0, i = 0; r < rows; r++) for (let col = 0; col < cols; col++, i++) {
        const x = col * CW + CW / 2, y = r * CH + CH / 2
        const qx = Math.abs(x - pw / 2) - (pw / 2 - rad), qy = Math.abs(y - ph / 2) - (ph / 2 - rad)
        if (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad > 0) continue
        const a = data[i * 4 + 3] / 255
        lum[i] = (data[i * 4] * .2126 + data[i * 4 + 1] * .7152 + data[i * 4 + 2] * .0722) / 255 * a
        inside[i] = 1
        sample.push(lum[i])
      }
      sample.sort((a, b) => a - b)
      const lo = sample[Math.floor(sample.length * .05)] ?? 0, hi = sample[Math.floor(sample.length * .95)] ?? 1
      const mask = new Float32Array(cols * rows)
      for (let i = 0; i < mask.length; i++)
        mask[i] = inside[i] ? Math.pow(Math.min(1, Math.max(0, (lum[i] - lo) / Math.max(.05, hi - lo))), .9) : -1
      entry.ready = { mask, cols, rows }
      return entry.ready
    }).catch(() => { entry.failed = true; return null }) }
    photoCache.set(key, entry)
    if (photoCache.size > 40) photoCache.delete(photoCache.keys().next().value)
  }
  return entry
}

export function createAsciiField(canvas, { reduced = false } = {}) {
  const ctx = canvas.getContext('2d')
  let dpr = 1, w = 0, h = 0, cols = 0, rows = 0, rect = { left: 0, top: 0 }
  let atlas = null, values, offX, offY, scr, layer = null, lctx = null, baseDirty = true, baseCode
  let raf = 0, lastDraw = 0, lastInput = -1e9, lastBeacon = 0, lastBase = -1e9, lastT = 0, dragPhase = 0, base
  let running = false, paused = false, focused = document.hasFocus(), destroyed = false
  const pointer = { x: 0, y: 0, amt: 0, on: false }
  const trail = []
  const waves = []
  let drag = null, dragAmt = 0
  let trash = null
  let glyph = null, prevGlyph = null
  let beaconFn = null
  const stats = { frames: 0, ms: 0, drawMs: 0, cells: 0 }

  function buildAtlas() {
    atlas = document.createElement('canvas')
    const aw = Math.round(CW * dpr), ah = Math.round(CH * dpr)
    atlas.width = aw * G; atlas.height = ah * LEVELS
    const g = atlas.getContext('2d')
    g.font = `${11 * dpr}px ui-monospace, "Cascadia Mono", Consolas, monospace`
    g.textAlign = 'center'; g.textBaseline = 'middle'
    for (let l = 0; l < LEVELS; l++) {
      g.fillStyle = `rgba(237,237,237,${((l + 1) / LEVELS) * MAX_ALPHA})`
      for (let i = 1; i < G; i++) g.fillText(RAMP[i], i * aw + aw / 2, l * ah + ah / 2)
    }
  }
  function resize() {
    const r = canvas.getBoundingClientRect()
    rect = r
    dpr = Math.min(1.5, devicePixelRatio || 1)
    w = r.width; h = r.height
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
    cols = Math.ceil(w / CW); rows = Math.ceil(h / CH)
    values = new Float32Array(cols * rows); base = new Float32Array(cols * rows); lastBase = -1e9; offX = new Float32Array(cols * rows); offY = new Float32Array(cols * rows); scr = new Uint8Array(cols * rows)
    layer = document.createElement('canvas'); layer.width = canvas.width; layer.height = canvas.height; lctx = layer.getContext('2d'); baseDirty = true
    baseCode = new Uint16Array(cols * rows)
    buildAtlas()
    if (glyph) glyph = Object.assign(place(glyph.spec), { key: glyph.key, amt: glyph.amt })
    prevGlyph = null
    kick(true)
  }
  const local = (x, y) => [x - rect.left, y - rect.top]

  function place(spec) {
    const { text, width, height, strength = .5, breathe = false, scramble = !reduced, shade = false } = spec
    const m = spec.mask ?? rasterize(text, width, height)
    // cy (opcional, em coordenadas da janela): centro vertical; sem ele, o centro do campo.
    const c0 = Math.round(w / 2 / CW - m.cols / 2), r0 = Math.round((spec.cy != null ? spec.cy - rect.top : h / 2) / CH - m.rows / 2)
    const seeds = new Float32Array(m.mask.length)
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random()
    return { ...m, c0, r0, seeds, born: performance.now(), strength, breathe, scramble, shade, spec, amt: 0 }
  }

  function draw(now) {
    const t0 = performance.now()
    const tt = now / 1000
    const still = reduced ? 0 : 1
    offX.fill(0); offY.fill(0); scr.fill(0)
    const dt = Math.min(.1, Math.max(0, tt - lastT)); lastT = tt

    // Base: ruido lento; arrastando, a amostragem anda na direcao do centro (o campo flui para a vaga).
    dragAmt += ((drag ? 1 : 0) - dragAmt) * .18
    if (dragAmt < .01) dragAmt = drag ? dragAmt : 0
    dragPhase += dt * 2.2 * dragAmt
    const cx = w / 2, cy = h / 2, maxD = Math.hypot(cx, cy)
    // A textura anda devagar: recalcula no maximo a cada 140 ms (50 ms arrastando) e fica numa camada pronta,
    // desenhada inteira com um drawImage; nos quadros so as celulas mexidas pelos efeitos sao redesenhadas.
    if (now - lastBase > (dragAmt ? 50 : 140) || now < lastBase) {
    lastBase = now; baseDirty = true
    for (let r = 0, i = 0; r < rows; r++) {
      const y = r * CH + CH / 2
      for (let c = 0; c < cols; c++, i++) {
        let sx = c * .09 + tt * .05 * still, sy = r * .13 + tt * .03 * still
        let pull = 0
        if (dragAmt) {
          const x = c * CW + CW / 2, dx = cx - x, dy = cy - y, d = Math.hypot(dx, dy) || 1
          sx -= dx / d * dragPhase; sy -= dy / d * dragPhase
          pull = dragAmt * .07 * (1 - d / maxD)
        }
        const n = noise(sx, sy) * .6 + noise(c * .31 + 40, r * .37 + tt * .11 * still) * .4
        const tex = Math.max(0, n - .4) * .62
        base[i] = tex > .035 ? tex + pull : 0
      }
    }
    }
    values.set(base)

    // Lente do mouse e rastro.
    pointer.amt += ((pointer.on && !reduced ? 1 : 0) - pointer.amt) * .15
    if (pointer.amt > .01) addRadial(pointer.x, pointer.y, 150, .42 * pointer.amt, 4 * pointer.amt)
    for (let k = trail.length - 1; k >= 0; k--) {
      const age = now - trail[k].t
      if (age > 450) { trail.splice(k, 1); continue }
      addRadial(trail[k].x, trail[k].y, 60, .2 * (1 - age / 450), 0)
    }

    // Ondas: anel que passa pela grade e empurra os caracteres para fora.
    for (let k = waves.length - 1; k >= 0; k--) {
      const wv = waves[k], age = now - wv.t
      if (age > wv.life) { waves.splice(k, 1); continue }
      const radius = age / 1000 * wv.speed, fade = 1 - age / wv.life, reach = radius + wv.width * 2.5
      const c1 = Math.max(0, Math.floor((wv.x - reach) / CW)), c2 = Math.min(cols - 1, Math.ceil((wv.x + reach) / CW))
      const r1 = Math.max(0, Math.floor((wv.y - reach) / CH)), r2 = Math.min(rows - 1, Math.ceil((wv.y + reach) / CH))
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        const x = c * CW + CW / 2, y = r * CH + CH / 2, dx = x - wv.x, dy = y - wv.y, d = Math.hypot(dx, dy) || 1
        const band = (d - radius) / wv.width
        if (band > 2.5 || band < -2.5) continue
        const g = Math.exp(-band * band) * wv.strength * fade, i = r * cols + c
        values[i] += g; offX[i] += dx / d * g * 7; offY[i] += dy / d * g * 7
      }
    }

    // Vaga do centro desenhada em caracteres; acende quando a carta esta perto.
    if (dragAmt && drag) {
      const [lx, ly] = local(drag.rect.left, drag.rect.top)
      const hw = drag.rect.width / 2, hh = drag.rect.height / 2, rx = lx + hw, ry = ly + hh, rad = 14
      const edge = (drag.near ? .62 : .3) * dragAmt, fill = drag.near ? .07 * dragAmt : 0
      const c1 = Math.max(0, Math.floor((rx - hw - CW * 2) / CW)), c2 = Math.min(cols - 1, Math.ceil((rx + hw + CW * 2) / CW))
      const r1 = Math.max(0, Math.floor((ry - hh - CH * 2) / CH)), r2 = Math.min(rows - 1, Math.ceil((ry + hh + CH * 2) / CH))
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        const x = c * CW + CW / 2, y = r * CH + CH / 2
        const qx = Math.abs(x - rx) - (hw - rad), qy = Math.abs(y - ry) - (hh - rad)
        const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad
        const i = r * cols + c
        // Tracejado que corre pelo contorno (andando no sentido horario).
        const march = .55 + .45 * Math.sin((Math.atan2(y - ry, x - rx) * 9 - tt * 5 * still))
        if (Math.abs(sd) < CH * .6) values[i] = Math.max(values[i], edge * (drag.near ? 1 : march))
        else if (sd < 0) values[i] += fill
      }
    }

    // Lixeira: caracteres em volta embaralham e somem durante os 1,5 s.
    if (trash) {
      const p = Math.min(1, (now - trash.t) / 1500)
      const [tx, ty] = local(trash.x, trash.y), R = 120
      const c1 = Math.max(0, Math.floor((tx - R) / CW)), c2 = Math.min(cols - 1, Math.ceil((tx + R) / CW))
      const r1 = Math.max(0, Math.floor((ty - R) / CH)), r2 = Math.min(rows - 1, Math.ceil((ty + R) / CH))
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        const x = c * CW + CW / 2, y = r * CH + CH / 2, d = Math.hypot(x - tx, y - ty)
        if (d > R) continue
        const f = 1 - d / R, i = r * cols + c
        values[i] = values[i] * (1 - p * f) + f * .3 * Math.sin(p * Math.PI)
        if (!reduced && Math.random() < p * f) scr[i] = 1 + Math.floor(Math.random() * (G - 1))
      }
    }

    // Texto grande no centro (iniciais do servidor em foco, ou a marca respirando).
    for (const gl of [prevGlyph, glyph]) {
      if (!gl) continue
      const target = gl === glyph ? 1 : 0
      gl.amt += (target - gl.amt) * (target ? .2 : .28)
      if (gl === prevGlyph && gl.amt < .02) { prevGlyph = null; continue }
      const strength = gl.strength * gl.amt * (gl.breathe ? .82 + .18 * Math.sin(tt * 1.3 * still) : 1)
      const age = running ? now - gl.born : Infinity // quadro estatico (parado): sem scramble congelado
      for (let r = 0; r < gl.rows; r++) {
        const rr = gl.r0 + r
        if (rr < 0 || rr >= rows) continue
        for (let c = 0; c < gl.cols; c++) {
          const cc = gl.c0 + c
          if (cc < 0 || cc >= cols) continue
          const k = r * gl.cols + c, m = gl.mask[k], i = rr * cols + cc
          if (gl.shade) {
            // Foto: tons da imagem pela rampa inteira (sombreado ASCII); um ponto fraco marca o contorno escuro.
            if (m < 0) { if (m > -2) values[i] -= base[i] * .4 * gl.amt; continue }
            values[i] = Math.max(values[i] - base[i] * gl.amt, (.07 + m * .93) * strength)
            if (gl.scramble && age < gl.seeds[k] * 420 && m > .2) scr[i] = 3 + Math.floor(Math.random() * (G - 3))
            continue
          }
          // Fora das letras a textura apaga um pouco; dentro, o texto substitui o ruido (leitura limpa).
          // So a textura sai: lente, ondas e vaga continuam passando pelas letras.
          if (m < .3) { values[i] -= base[i] * .65 * gl.amt * (1 - m / .3); continue }
          values[i] = Math.max(values[i] - base[i] * gl.amt, m * strength)
          // Letras com caracteres de peso fixo (miolo '+', meio '=', borda ':'), sem a variedade do ruido.
          if (values[i] <= m * strength + .01) scr[i] = m > .65 ? 6 : m > .4 ? 5 : 3
          if (gl.scramble && age < gl.seeds[k] * 420 && m > .25) scr[i] = 3 + Math.floor(Math.random() * (G - 3))
        }
      }
    }

    const t1 = performance.now()
    const aw = Math.round(CW * dpr), ah = Math.round(CH * dpr)
    const cell = v => [1 + Math.min(G - 2, Math.floor(v * (G - 1) * 1.15)), Math.min(LEVELS - 1, Math.floor(v * LEVELS))]
    if (baseDirty) {
      baseDirty = false
      // So as celulas cujo caractere ou nivel mudou desde a ultima textura (o ruido anda devagar: poucas por vez).
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      for (let r = 0, i = 0; r < rows; r++) for (let c = 0; c < cols; c++, i++) {
        const v = base[i]
        let code = 0, gi = 0, li = 0
        if (v >= .035) { [gi, li] = cell(Math.min(1, v)); code = 1 + gi * LEVELS + li }
        if (code === baseCode[i]) continue
        if (baseCode[i]) lctx.clearRect(c * CW, r * CH, CW, CH)
        baseCode[i] = code
        if (code) lctx.drawImage(atlas, gi * aw, li * ah, aw, ah, c * CW, r * CH, CW, CH)
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(layer, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    let drawn = 0
    for (let r = 0, i = 0; r < rows; r++) {
      const y = r * CH
      for (let c = 0; c < cols; c++, i++) {
        if (values[i] === base[i] && !offX[i] && !offY[i] && !scr[i]) continue
        if (base[i] >= .035) ctx.clearRect(c * CW, y, CW, CH)
        const v = Math.min(1, values[i])
        if (v < .035) continue
        drawn++
        const [gi, li] = cell(v)
        ctx.drawImage(atlas, (scr[i] || gi) * aw, li * ah, aw, ah, c * CW + offX[i], y + offY[i], CW, CH)
      }
    }
    stats.frames++; stats.ms += performance.now() - t0; stats.drawMs += performance.now() - t1; stats.cells += drawn
  }

  function addRadial(px, py, R, gain, push) {
    const c1 = Math.max(0, Math.floor((px - R) / CW)), c2 = Math.min(cols - 1, Math.ceil((px + R) / CW))
    const r1 = Math.max(0, Math.floor((py - R) / CH)), r2 = Math.min(rows - 1, Math.ceil((py + R) / CH))
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const x = c * CW + CW / 2, y = r * CH + CH / 2, dx = x - px, dy = y - py, d = Math.hypot(dx, dy)
      if (d >= R) continue
      const f = 1 - d / R, f2 = f * f, i = r * cols + c
      values[i] += f2 * gain
      if (push && d > 0) { offX[i] += dx / d * f2 * push; offY[i] += dy / d * f2 * push }
    }
  }

  function busy(now) {
    return now - lastInput < 700 || drag || trash || dragAmt > .01 || pointer.amt > .02 && !pointer.on ||
      waves.some(wv => !wv.soft) || prevGlyph || glyph && (glyph.amt < .98 || now - glyph.born < 450)
  }
  function frame() {
    // performance.now(): o carimbo do rAF pode vir de outra origem de tempo (visto no painel do app).
    const now = performance.now()
    raf = 0
    if (!running) return
    raf = requestAnimationFrame(frame)
    // Sinal ao vivo: um anel lento a cada 2,4 s saindo das cartas dos servidores com transmissao.
    if (beaconFn && now - lastBeacon > 2400) {
      lastBeacon = now
      for (const p of beaconFn() || []) { const [x, y] = local(p.x, p.y); waves.push({ x, y, t: now, speed: 110, width: 22, strength: .17, life: 2300, soft: true }) }
    }
    const interval = busy(now) ? 1000 / 30 : 1000 / 12
    if (now - lastDraw < interval - 2) return
    lastDraw = now
    draw(now)
  }
  function kick(force) {
    if (destroyed) return
    // Movimento reduzido: textura e texto estaticos, redesenhados so quando mudam.
    if (reduced) { if (force) requestAnimationFrame(() => !destroyed && w && draw(0)); return }
    const should = !paused && focused && !document.hidden
    if (should && !running) { running = true; raf = requestAnimationFrame(frame) }
    else if (!should && running) {
      running = false; cancelAnimationFrame(raf); raf = 0
      // Ultimo quadro sem lente, rastro nem ondas: parado, o campo fica so com a textura.
      pointer.amt = 0; trail.length = 0; waves.length = 0; drag = null; dragAmt = 0; trash = null
      if (glyph) glyph.amt = 1
      prevGlyph = null
      if (w) draw(performance.now())
    } else if (force && !running && w) draw(performance.now())
  }

  const onFocus = () => { focused = true; kick() }
  const onBlur = () => { focused = false; pointer.on = false; kick() }
  const onVis = () => kick()
  addEventListener('focus', onFocus); addEventListener('blur', onBlur); document.addEventListener('visibilitychange', onVis)
  const ro = new ResizeObserver(resize)
  ro.observe(canvas)
  resize()

  return {
    pointer(x, y) {
      const [lx, ly] = local(x, y)
      const last = trail[trail.length - 1], now = performance.now()
      if (!last || Math.hypot(lx - last.x, ly - last.y) > 10) { trail.push({ x: lx, y: ly, t: now }); if (trail.length > 14) trail.shift() }
      pointer.x = lx; pointer.y = ly; pointer.on = true; lastInput = now
    },
    leave() { pointer.on = false },
    wave(x, y, { strength = .9, speed, width = 60, life = 900 } = {}) {
      if (reduced) return
      const [lx, ly] = local(x, y)
      const reach = Math.hypot(Math.max(lx, w - lx), Math.max(ly, h - ly)) + width
      waves.push({ x: lx, y: ly, t: performance.now(), speed: speed ?? reach / (life / 1000) * 1.1, width, strength, life })
      lastInput = performance.now()
    },
    drag(state) { drag = state; lastInput = performance.now() },
    trash(state) { if (!state) trash = null; else if (!trash) trash = { ...state, t: performance.now() } },
    glyph(spec) {
      const key = spec && (spec.key ?? JSON.stringify([spec.text, spec.width | 0, spec.height | 0, spec.strength, spec.breathe]))
      if (key === (glyph?.key ?? null)) return
      if (glyph) prevGlyph = glyph
      glyph = spec ? Object.assign(place(spec), { key }) : null
      if (reduced || !running) { if (glyph) glyph.amt = 1; prevGlyph = null }
      lastInput = performance.now()
      kick(true)
    },
    beacons(fn) { beaconFn = fn },
    pause(on) { paused = on; kick() },
    stats,
    debug: () => glyph && { text: glyph.spec.text, c0: glyph.c0, r0: glyph.r0, cols: glyph.cols, rows: glyph.rows, amt: glyph.amt, max: Math.max(...glyph.mask) },
    destroy() {
      destroyed = true; running = false; cancelAnimationFrame(raf); ro.disconnect()
      removeEventListener('focus', onFocus); removeEventListener('blur', onBlur); document.removeEventListener('visibilitychange', onVis)
    },
  }
}
