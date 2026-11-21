// Fisica de prioridade das cartas em leque.
// Uma carta nunca atravessa outra: quando a ordem de empilhamento entre duas cartas sobrepostas inverte,
// a que vai ficar por baixo desliza de leve para o lado (afastando-se da outra), a outra sobe,
// a ordem troca no pico do desvio e a carta desviada volta para o seu lugar, agora por baixo.
// Uso: attachFanPhysics(container, '.deck-card', { overlapAt }) -> detach. Cada carta informa a ordem base em data-z.
// overlapAt(a, b): sobreposicao em px no leque aberto, para leques que abrem no hover (o deck): medir as caixas
// no meio da abertura faria cartas distantes desviarem sem necessidade.
// Ao tirar o mouse, o container fica com .is-settling (o CSS mantem o leque aberto) ate a carta voltar
// para baixo das vizinhas; so entao o leque fecha, ja na ordem certa.

const OUT_MS = 190 // tempo do desvio: o mesmo da subida da carta que ganha prioridade
const TOP = 60
const INTENT_MS = 70 // passar rapido por cima de uma carta no caminho nao a puxa para cima

export function attachFanPhysics(container, selector, { overlapAt } = {}) {
  let applied = null // carta que esta efetivamente por cima
  let wanted = null
  let timer = 0
  let intent = 0
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const cards = () => [...container.querySelectorAll(selector)].filter(c => !c.hidden)
  const zOf = (card, prio) => card === prio ? TOP : Number(card.dataset.z) || 0

  function apply(prio) {
    applied = prio
    for (const card of cards()) card.style.zIndex = card === prio ? String(TOP) : ''
  }

  function setNudge(card, px) {
    card.style.setProperty('--nudge', px ? px.toFixed(1) + 'px' : '0px')
    card.style.setProperty('--nudge-r', px ? (Math.sign(px) * 4) + 'deg' : '0deg')
    card.classList.toggle('is-nudged', !!px)
  }

  function target(next) {
    if (next === wanted) return
    wanted = next
    clearTimeout(timer)
    const list = cards()
    if (reduced()) { list.forEach(c => setNudge(c, 0)); apply(next); container.classList.remove('is-settling'); return }
    const rects = new Map(list.map(c => [c, c.getBoundingClientRect()]))
    // Sobreposicao horizontal em px (caixas ja rotacionadas).
    const overlap = (a, b) => {
      if (overlapAt) return overlapAt(a, b)
      const ra = rects.get(a), rb = rects.get(b)
      return Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
    }
    let flips = 0
    for (const card of list) {
      // Desvia das cartas que passam a ficar por cima dela.
      // O desvio e so o necessario para abrir passagem, com teto de 22% da largura.
      let push = 0, count = 0, depth = 0
      for (const other of list) {
        if (other === card) continue
        const shared = overlap(card, other)
        if (shared <= 4) continue
        if (zOf(card, applied) > zOf(other, applied) && zOf(card, next) < zOf(other, next)) {
          const a = rects.get(card), b = rects.get(other)
          push += Math.sign((a.left + a.width / 2) - (b.left + b.width / 2)) || 1
          depth = Math.max(depth, shared)
          count++
        }
      }
      const width = rects.get(card).width
      const distance = Math.min(Math.max(depth * 0.4 + 6, 10), width * 0.22, 30)
      setNudge(card, count ? Math.sign(push || 1) * distance : 0)
      if (count) flips++
    }
    if (!flips) { apply(next); container.classList.remove('is-settling'); return }
    container.classList.toggle('is-settling', !next)
    // No pico do desvio a ordem troca e as cartas desviadas voltam para o lugar.
    timer = setTimeout(() => {
      apply(next)
      cards().forEach(c => setNudge(c, 0))
      container.classList.remove('is-settling')
    }, OUT_MS)
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
    clearTimeout(timer)
    clearTimeout(intent)
    container.removeEventListener('pointerover', over)
    container.removeEventListener('pointerleave', leave)
    container.removeEventListener('focusin', focusIn)
    container.removeEventListener('focusout', focusOut)
    container.classList.remove('is-settling')
    for (const card of cards()) { card.style.zIndex = ''; setNudge(card, 0) }
  }
}
