// Fisica de prioridade das cartas em leque. Uma carta nunca atravessa outra.
// Ordem base: a mais a esquerda por cima (data-z); a carta em foco fica acima de todas.
// Quando o foco vai para uma carta, as vizinhas que a cobrem abrem espaco para os lados (so o necessario,
// com queda conforme a distancia) e a ordem de empilhamento so muda quando as cartas envolvidas nao se
// sobrepoem mais. Isso vale para a carta que ganha o foco e para a que o perde: a carta que sai do foco
// desce por baixo das vizinhas enquanto ainda esta livre, e so depois as vizinhas voltam para o lugar.
// A sobreposicao e medida na geometria real (translate/rotate/scale/transform/left atuais, com SAT),
// entao trocas rapidas no meio de uma animacao tambem esperam a passagem abrir.
// Uso: attachFanPhysics(container, '.deck-card', { positionAt }) -> detach.
// positionAt(card): x do centro da carta no leque aberto (para leques que abrem no hover, como o deck).
// O CSS usa --part (px) somado ao `left` da carta, com transicao curta.

const TOP = 60
const INTENT_MS = 60 // passar rapido por cima de uma carta no caminho nao mexe no leque
const FALLBACK_MS = 420 // se a passagem nao abrir (layout inesperado), troca mesmo assim
const GAP = 8 // folga entre a carta em foco (ja ampliada) e as vizinhas

export function attachFanPhysics(container, selector, { positionAt } = {}) {
  let wanted = null // carta sob o ponteiro (ou foco do teclado)
  let top = null // carta com z-index TOP aplicado
  let lowering = null // carta que precisa sair do topo
  let raising = null // carta que precisa ir para o topo
  let parted = undefined // carta para a qual o leque esta aberto
  let since = 0
  let raf = 0
  let intent = 0
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const cards = () => [...container.querySelectorAll(selector)].filter(c => !c.hidden)
  const base = card => Number(card.dataset.z) || 0
  const zOf = card => card === top ? TOP : base(card)

  function setZ(card, z) { card.style.zIndex = z === TOP ? String(TOP) : '' }

  // Abre o leque em volta de h (ou fecha, com h = null).
  function part(h) {
    if (parted === h) return
    parted = h
    const list = cards()
    if (!h || reduced()) { for (const c of list) c.style.setProperty('--part', '0px'); return }
    const xOf = c => positionAt ? positionAt(c) : parseFloat(getComputedStyle(c).translate) || 0
    const hx = xOf(h), hz = base(h)
    // So as cartas que ficam por cima de h na ordem base precisam se afastar dela. O espaco e dividido:
    // essas cartas vao metade para um lado, e h (com as cartas abaixo dela) vai a outra metade para o outro.
    const above = list.filter(c => c !== h && base(c) > hz)
    const need = c => (h.offsetWidth * 1.08 + c.offsetWidth) / 2 + GAP - Math.abs(xOf(c) - hx)
    const most = Math.max(0, ...above.map(need))
    const side = Math.sign(above.reduce((sum, c) => sum + xOf(c) - hx, 0)) || -1
    const half = Math.min(most / 2, h.offsetWidth * .4) // h nunca sai de baixo do ponteiro
    for (const c of list) {
      const shift = !most ? 0 : base(c) > hz && c !== h ? side * Math.max(0, need(c) - half) : -side * half
      c.style.setProperty('--part', shift.toFixed(1) + 'px')
    }
  }

  // Quadrilatero da carta no espaco do container, com as transformacoes atuais (inclusive no meio da transicao).
  function quad(card) {
    const s = getComputedStyle(card)
    const w = card.offsetWidth, h = card.offsetHeight
    const len = (v, ref) => v.endsWith('%') ? parseFloat(v) / 100 * ref : parseFloat(v) || 0
    const [ox, oy] = s.transformOrigin.split(' ').map((v, i) => len(v, i ? h : w))
    const [tx = '0', ty = '0'] = s.translate === 'none' ? [] : s.translate.split(' ')
    const rot = s.rotate === 'none' ? 0 : parseFloat(s.rotate.split(' ').pop()) || 0
    const sc = s.scale === 'none' ? [1, 1] : s.scale.split(' ').map(Number)
    const m = new DOMMatrix()
      .translate(card.offsetLeft + ox, card.offsetTop + oy)
      .translate(len(tx, w), len(ty, h))
      .rotate(rot)
      .scale(sc[0], sc[1] ?? sc[0])
      .multiply(new DOMMatrix(s.transform === 'none' ? undefined : s.transform))
      .translate(-ox, -oy)
    return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => { const p = m.transformPoint({ x, y }); return [p.x, p.y] })
  }

  // Teorema do eixo separador: penetracao menor que 1,5 px conta como livre.
  function overlaps(a, b) {
    for (const q of [a, b]) {
      for (let i = 0; i < 4; i++) {
        const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]
        const nx = y1 - y2, ny = x2 - x1, len = Math.hypot(nx, ny) || 1
        const proj = p => (p[0] * nx + p[1] * ny) / len
        const pa = a.map(proj), pb = b.map(proj)
        if (Math.max(...pa) <= Math.min(...pb) + 1.5 || Math.max(...pb) <= Math.min(...pa) + 1.5) return false
      }
    }
    return true
  }

  // A troca de z de `card` e invisivel se nenhuma carta sobreposta muda de lado em relacao a ela.
  function safe(card, z) {
    const list = cards()
    const index = new Map(list.map((c, i) => [c, i]))
    const above = (za, ia, zb, ib) => za > zb || (za === zb && ia > ib)
    let mine = null
    for (const o of list) {
      if (o === card) continue
      const zo = zOf(o)
      if (above(zOf(card), index.get(card), zo, index.get(o)) === above(z, index.get(card), zo, index.get(o))) continue
      mine ??= quad(card)
      if (overlaps(mine, quad(o))) return false
    }
    return true
  }

  function tick() {
    raf = 0
    const late = performance.now() - since > FALLBACK_MS
    if (lowering) {
      if (late || safe(lowering, base(lowering))) {
        setZ(lowering, 0)
        if (top === lowering) top = null
        lowering = null
        since = performance.now()
      } else return schedule()
    }
    if (raising) {
      part(raising)
      if (late || safe(raising, TOP)) {
        setZ(raising, TOP)
        top = raising
        raising = null
      } else return schedule()
    }
    if (!wanted) part(null)
    container.classList.toggle('is-settling', false)
  }
  const schedule = () => { raf ||= requestAnimationFrame(tick) }

  function target(next) {
    if (next === wanted && !lowering && !raising) return
    wanted = next
    since = performance.now()
    if (reduced()) {
      for (const c of cards()) { setZ(c, c === next ? TOP : 0); c.style.setProperty('--part', '0px') }
      top = next; lowering = raising = null; parted = undefined
      container.classList.remove('is-settling')
      return
    }
    lowering = top && top !== next ? top : null
    raising = next && next !== top ? next : null
    if (next && next === top) part(next)
    // Sem foco, o leque fica aberto ate a carta descer por baixo das vizinhas.
    container.classList.toggle('is-settling', !next && !!lowering)
    cancelAnimationFrame(raf); raf = 0
    tick()
  }

  const cardFrom = e => {
    const card = e.target.closest?.(selector)
    return card && container.contains(card) && !card.hidden ? card : null
  }
  // A primeira carta responde na hora; trocas seguintes esperam o ponteiro assentar.
  const aim = next => {
    clearTimeout(intent)
    if (!wanted || reduced()) target(next)
    else intent = setTimeout(() => target(next), INTENT_MS)
  }
  const over = e => { if (e.pointerType !== 'touch') aim(cardFrom(e)) }
  const leave = e => { if (e.pointerType !== 'touch' && !container.contains(document.activeElement)) aim(null) }
  const focusIn = e => { if (e.target.matches?.(':focus-visible')) target(cardFrom(e)) }
  const focusOut = e => { if (!container.contains(e.relatedTarget) && !container.matches(':hover')) target(null) }

  container.addEventListener('pointerover', over)
  container.addEventListener('pointerleave', leave)
  container.addEventListener('focusin', focusIn)
  container.addEventListener('focusout', focusOut)
  return () => {
    cancelAnimationFrame(raf)
    clearTimeout(intent)
    container.removeEventListener('pointerover', over)
    container.removeEventListener('pointerleave', leave)
    container.removeEventListener('focusin', focusIn)
    container.removeEventListener('focusout', focusOut)
    container.classList.remove('is-settling')
    for (const card of cards()) { card.style.zIndex = ''; card.style.setProperty('--part', '0px') }
  }
}
