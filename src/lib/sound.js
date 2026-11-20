// Sons do Visor: todos sintetizados com Web Audio (nada de arquivos). Suaves, curtos e baixos.
// play('nome') toca; o volume e ligado/desligado ficam em localStorage ('visor.sound').
const KEY = 'visor.sound'
let ctx = null, master = null, noiseBuf = null
const last = new Map()

function prefs() {
  try { return { on: true, volume: 0.6, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch { return { on: true, volume: 0.6 } }
}
export function soundPrefs() { return prefs() }
export function setSoundPrefs(change) {
  const next = { ...prefs(), ...change }
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch {}
  if (master) master.gain.value = next.on ? next.volume : 0
  dispatchEvent(new CustomEvent('visor-sound', { detail: next }))
  return next
}

function audio() {
  if (typeof AudioContext === 'undefined') return null
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' })
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18; comp.ratio.value = 3; comp.attack.value = 0.003; comp.release.value = 0.2
    master = ctx.createGain()
    const p = prefs()
    master.gain.value = p.on ? p.volume : 0
    master.connect(comp).connect(ctx.destination)
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const d = noiseBuf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}
// O navegador so libera audio apos um gesto: a primeira interacao ja deixa o contexto pronto.
if (typeof window !== 'undefined') {
  const unlock = () => { audio(); removeEventListener('pointerdown', unlock); removeEventListener('keydown', unlock) }
  addEventListener('pointerdown', unlock)
  addEventListener('keydown', unlock)
}

// ---------- blocos ----------
function env(param, t, attack, peak, hold, release) {
  param.setValueAtTime(0.0001, t)
  param.exponentialRampToValueAtTime(peak, t + attack)
  if (hold) param.setValueAtTime(peak, t + attack + hold)
  param.exponentialRampToValueAtTime(0.0001, t + attack + hold + release)
  return t + attack + hold + release
}
function tone(t, { type = 'sine', from, to = from, glide = 0.05, attack = 0.005, peak = 0.1, hold = 0, release = 0.2, pan = 0, out = master }) {
  const o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner()
  o.type = type
  o.frequency.setValueAtTime(from, t)
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + glide)
  p.pan.value = pan
  const end = env(g.gain, t, attack, peak, hold, release)
  o.connect(g).connect(p).connect(out)
  o.start(t); o.stop(end + 0.05)
}
function noise(t, { type = 'bandpass', from = 1000, to = from, q = 0.8, sweep = 0.2, attack = 0.01, peak = 0.1, hold = 0, release = 0.15, pan = 0, panTo = pan, out = master }) {
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner()
  s.buffer = noiseBuf
  s.loopStart = 0; s.loopEnd = 2; s.loop = true
  f.type = type; f.Q.value = q
  f.frequency.setValueAtTime(from, t)
  if (to !== from) f.frequency.exponentialRampToValueAtTime(to, t + sweep)
  p.pan.setValueAtTime(pan, t)
  if (panTo !== pan) p.pan.linearRampToValueAtTime(panTo, t + attack + hold + release)
  const end = env(g.gain, t, attack, peak, hold, release)
  s.connect(f).connect(g).connect(p).connect(out)
  s.start(t, Math.random() * 1.5); s.stop(end + 0.05)
}

// ---------- catalogo ----------
export const SOUNDS = {
  wave: {
    label: 'Onda', use: 'Servidor colocado no centro do deck (a onda de choque)',
    play(t) {
      // corpo da onda: ruido grave que sobe e desce, atravessando de um lado ao outro
      noise(t, { type: 'lowpass', from: 220, to: 1600, sweep: 0.55, q: 0.6, attack: 0.38, peak: 0.22, hold: 0.1, release: 1.1, pan: -0.5, panTo: 0.5 })
      // espuma: chiado agudo e baixinho no pico
      noise(t + 0.3, { type: 'highpass', from: 2600, to: 5200, sweep: 0.6, q: 0.3, attack: 0.25, peak: 0.045, release: 0.9, pan: 0.2, panTo: -0.3 })
      // agua recuando
      noise(t + 0.75, { type: 'bandpass', from: 1400, to: 380, sweep: 0.9, q: 0.9, attack: 0.15, peak: 0.06, release: 0.9 })
      tone(t, { from: 74, to: 52, glide: 1.1, attack: 0.3, peak: 0.06, release: 0.9 })
    },
  },
  drop: {
    label: 'Gota', use: 'Mensagem recebida no chat',
    play(t) {
      tone(t, { from: 520, to: 1280, glide: 0.035, attack: 0.003, peak: 0.13, release: 0.16 })
      tone(t + 0.085, { from: 760, to: 1720, glide: 0.03, attack: 0.003, peak: 0.06, release: 0.13, pan: 0.25 })
    },
  },
  send: {
    label: 'Bolha', use: 'Mensagem enviada',
    play(t) { tone(t, { from: 880, to: 430, glide: 0.08, attack: 0.004, peak: 0.08, release: 0.12 }) },
  },
  lift: {
    label: 'Levantar carta', use: 'Pegar uma carta (deck, mão ou transmissão segurada)',
    play(t) { noise(t, { from: 1800, to: 5200, sweep: 0.12, q: 1.2, attack: 0.02, peak: 0.07, release: 0.11 }) },
  },
  place: {
    label: 'Pousar carta', use: 'Carta colocada na mesa',
    play(t) {
      noise(t, { type: 'lowpass', from: 1200, to: 400, sweep: 0.06, attack: 0.002, peak: 0.16, release: 0.07 })
      tone(t, { from: 150, to: 88, glide: 0.1, attack: 0.002, peak: 0.12, release: 0.12 })
    },
  },
  back: {
    label: 'Voltar para a mão', use: 'Transmissão devolvida à mão ou carta de volta ao deck',
    play(t) {
      noise(t, { from: 4200, to: 1300, sweep: 0.18, q: 1, attack: 0.02, peak: 0.06, release: 0.16 })
      tone(t + 0.03, { from: 520, to: 330, glide: 0.12, attack: 0.01, peak: 0.035, release: 0.14 })
    },
  },
  flip: {
    label: 'Virar carta', use: 'A transmissão conectou e a carta virou',
    play(t) {
      noise(t, { type: 'highpass', from: 3000, attack: 0.001, peak: 0.08, release: 0.02 })
      noise(t + 0.07, { type: 'highpass', from: 3600, attack: 0.001, peak: 0.06, release: 0.02 })
      tone(t + 0.1, { from: 1318.5, attack: 0.01, peak: 0.035, release: 0.5, pan: -0.2 })
      tone(t + 0.14, { from: 1975.5, attack: 0.01, peak: 0.022, release: 0.55, pan: 0.2 })
    },
  },
  fail: {
    label: 'Sem conexão', use: 'A transmissão não conectou',
    play(t) {
      tone(t, { type: 'triangle', from: 392, attack: 0.01, peak: 0.07, release: 0.25 })
      tone(t + 0.17, { type: 'triangle', from: 293.7, attack: 0.01, peak: 0.07, release: 0.4 })
    },
  },
  live: {
    label: 'Ao vivo', use: 'Você começou a transmitir',
    play(t) {
      ;[523.3, 659.3, 784, 1046.5].forEach((f, i) => tone(t + i * 0.06, { from: f, attack: 0.02, peak: 0.05, release: 0.9 - i * 0.1, pan: -0.3 + i * 0.2 }))
      noise(t, { type: 'highpass', from: 3000, to: 6000, sweep: 0.5, attack: 0.25, peak: 0.02, release: 0.5 })
    },
  },
  stop: {
    label: 'Fim da transmissão', use: 'Você parou de transmitir',
    play(t) { ;[784, 659.3, 523.3].forEach((f, i) => tone(t + i * 0.07, { from: f, attack: 0.01, peak: 0.05, release: 0.35 })) },
  },
  chime: {
    label: 'Nova transmissão', use: 'Alguém começou a transmitir (carta nova na mão)',
    play(t) {
      tone(t, { from: 784, attack: 0.004, peak: 0.07, release: 1.1 })
      tone(t, { from: 1176, attack: 0.004, peak: 0.035, release: 0.8 })
      tone(t + 0.12, { from: 1568, attack: 0.004, peak: 0.03, release: 0.9, pan: 0.3 })
    },
  },
  join: {
    label: 'Entrou na sala', use: 'Alguém entrou no canal',
    play(t) {
      tone(t, { type: 'triangle', from: 587.3, attack: 0.004, peak: 0.05, release: 0.18 })
      tone(t + 0.08, { type: 'triangle', from: 880, attack: 0.004, peak: 0.05, release: 0.25 })
    },
  },
  leave: {
    label: 'Saiu da sala', use: 'Alguém saiu do canal',
    play(t) {
      tone(t, { type: 'triangle', from: 880, attack: 0.004, peak: 0.04, release: 0.16 })
      tone(t + 0.08, { type: 'triangle', from: 587.3, attack: 0.004, peak: 0.04, release: 0.25 })
    },
  },
  enter: {
    label: 'Entrar na mesa', use: 'Você entrou num canal de transmissão (sua carta pousou na mesa)',
    play(t) {
      noise(t, { type: 'lowpass', from: 1100, to: 380, sweep: 0.07, attack: 0.002, peak: 0.15, release: 0.08 })
      tone(t, { from: 140, to: 90, glide: 0.1, attack: 0.002, peak: 0.1, release: 0.14 })
      noise(t + 0.08, { from: 700, to: 3000, sweep: 0.45, q: 0.7, attack: 0.18, peak: 0.035, release: 0.4, pan: -0.3, panTo: 0.3 })
      tone(t + 0.12, { from: 587.3, attack: 0.02, peak: 0.045, release: 0.6, pan: -0.2 })
      tone(t + 0.22, { from: 880, attack: 0.02, peak: 0.04, release: 0.8, pan: 0.2 })
    },
  },
  exit: {
    label: 'Sair da mesa', use: 'Você saiu do canal e voltou ao tabuleiro',
    play(t) {
      noise(t, { from: 3000, to: 600, sweep: 0.4, q: 0.7, attack: 0.05, peak: 0.04, release: 0.35, pan: 0.3, panTo: -0.3 })
      tone(t + 0.02, { from: 880, attack: 0.02, peak: 0.035, release: 0.35, pan: 0.2 })
      tone(t + 0.14, { from: 587.3, attack: 0.02, peak: 0.035, release: 0.55, pan: -0.2 })
    },
  },
  open: {
    label: 'Abrir painel', use: 'A carta Transmitir vira o painel de opções',
    play(t) { noise(t, { from: 500, to: 2600, sweep: 0.24, q: 0.9, attack: 0.08, peak: 0.06, release: 0.18 }) },
  },
  crumple: {
    label: 'Papel amassado', use: 'Servidor apagado na lixeira',
    play(t) {
      for (let i = 0; i < 16; i++) {
        const at = t + Math.random() * 0.42
        noise(at, { from: 1400 + Math.random() * 3800, q: 2 + Math.random() * 3, attack: 0.002, peak: 0.04 + Math.random() * 0.07, release: 0.01 + Math.random() * 0.03, pan: Math.random() - 0.5 })
      }
      noise(t + 0.4, { type: 'lowpass', from: 2400, to: 300, sweep: 0.3, attack: 0.04, peak: 0.07, release: 0.28 })
    },
  },
}

export function play(name, { gain = 1 } = {}) {
  const s = SOUNDS[name]
  if (!s || !prefs().on) return
  const a = audio()
  if (!a || a.state !== 'running' && a.state !== 'suspended') return
  const now = performance.now()
  if (now - (last.get(name) ?? 0) < 90) return // evita rajadas do mesmo som
  last.set(name, now)
  if (gain === 1) { s.play(a.currentTime + 0.01); return }
  const g = a.createGain()
  g.gain.value = gain
  g.connect(master)
  const prev = master
  master = g
  try { s.play(a.currentTime + 0.01) } finally { master = prev }
}
