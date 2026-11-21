// Gera os 8 corpos celestes usados como capa dos servidores sem foto (src/assets/celestial/*.svg).
// Escala de cinza, fundo quase preto, 512x512. Rodar: node scripts/celestial.mjs
// Aleatoriedade com semente fixa: o mesmo arquivo a cada execucao.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'celestial')
mkdirSync(out, { recursive: true })

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const f = n => +n.toFixed(1)
const svg = (body, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs>${defs}</defs><rect width="512" height="512" fill="#050505"/>${body}</svg>\n`

// Campo de estrelas: pontos pequenos e fracos, alguns com brilho.
function stars(seed, n, avoid) {
  const r = rng(seed)
  let s = ''
  for (let i = 0; i < n; i++) {
    const x = r() * 512, y = r() * 512
    if (avoid && Math.hypot(x - avoid[0], y - avoid[1]) < avoid[2]) continue
    const big = r() < .08
    s += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(big ? 1.3 + r() : .5 + r() * .6)}" fill="#fff" opacity="${f(big ? .7 : .15 + r() * .35)}"/>`
  }
  return s
}

const files = {}

// 1. Saturno: aneis inclinados (C fraco, B brilhante, divisao de Cassini, A), sombra dos aneis no planeta.
{
  const tilt = -16, cx = 256, cy = 262, R = 108
  const profile = rx => rx < 140 ? 0 : rx < 162 ? .16 : rx < 196 ? .55 + .2 * Math.sin((rx - 162) / 34 * Math.PI) : rx < 203 ? .04 : rx < 232 ? (rx > 222 && rx < 225 ? .08 : .42) : 0
  let ring = ''
  for (let rx = 140; rx < 232; rx += 2) {
    const o = profile(rx)
    if (o) ring += `<ellipse rx="${rx}" ry="${f(rx * .25)}" fill="none" stroke="#ececec" stroke-opacity="${f(o)}" stroke-width="2.4"/>`
  }
  const bands = [[-72, 20, .2, '#000'], [-44, 12, .14, '#fff'], [-20, 18, .22, '#000'], [6, 10, .12, '#fff'], [28, 22, .2, '#000'], [64, 16, .16, '#000']]
    .map(([y, h, o, c]) => `<rect x="-140" y="${y}" width="280" height="${h}" fill="${c}" opacity="${o}"/>`).join('')
  files.saturn = svg(`
${stars(11, 120, [cx, cy, 250])}
<g transform="translate(${cx} ${cy}) rotate(${tilt})">
  <g clip-path="url(#back)">${ring}</g>
  <path d="M30 -10 L240 -40 L240 -4 L30 0 Z" fill="#050505" opacity=".85" filter="url(#bandblur)"/>
  <g clip-path="url(#ball)">
    <circle r="${R}" fill="url(#lit)"/>
    <g filter="url(#bandblur)">${bands}</g>
    <ellipse cx="0" cy="${f(R * .42)}" rx="230" ry="12" fill="#000" opacity=".5" filter="url(#bandblur)"/>
    <circle r="${R}" fill="url(#limb)"/>
  </g>
  <g clip-path="url(#front)">${ring}</g>
</g>`, `
<radialGradient id="lit" cx="34%" cy="28%" r="80%"><stop offset="0" stop-color="#f4f4f4"/><stop offset=".45" stop-color="#a9a9a9"/><stop offset=".85" stop-color="#3a3a3a"/><stop offset="1" stop-color="#1a1a1a"/></radialGradient>
<radialGradient id="limb" r="50%"><stop offset=".7" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>
<clipPath id="ball"><circle r="${R}"/></clipPath>
<clipPath id="back"><rect x="-260" y="-120" width="520" height="120"/></clipPath>
<clipPath id="front"><rect x="-260" y="0" width="520" height="120"/></clipPath>
<filter id="bandblur" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>`)
}

// 2. Gigante gasoso: faixas turbulentas, grande mancha, escurecimento no limbo e terminador.
{
  const R = 150
  const r = rng(22)
  let bands = '', y = -R - 40
  while (y < R + 40) {
    const h = 8 + r() * 26
    const g = Math.round(90 + r() * 140)
    bands += `<rect x="-${R + 50}" y="${f(y)}" width="${R * 2 + 100}" height="${f(h + 1)}" fill="rgb(${g},${g},${g})"/>`
    y += h
  }
  files.jupiter = svg(`
${stars(22, 110, [256, 256, 200])}
<g transform="translate(256 256) rotate(-8)">
  <g clip-path="url(#ball)">
    <g filter="url(#swirl)">${bands}
      <ellipse cx="54" cy="58" rx="34" ry="19" fill="#5a5a5a"/><ellipse cx="54" cy="58" rx="22" ry="11" fill="#cfcfcf"/><ellipse cx="54" cy="58" rx="12" ry="6" fill="#8a8a8a"/>
      <ellipse cx="-70" cy="-30" rx="14" ry="6" fill="#eee"/><ellipse cx="-20" cy="96" rx="10" ry="5" fill="#eee"/>
    </g>
    <circle r="${R}" fill="url(#shade)"/>
    <circle r="${R}" fill="url(#limb)"/>
  </g>
  <circle r="${R + 1}" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width="3" filter="url(#glow)"/>
</g>`, `
<clipPath id="ball"><circle r="${R}"/></clipPath>
<filter id="swirl" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency=".006 .045" numOctaves="3" seed="7"/><feDisplacementMap in="SourceGraphic" scale="34" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur stdDeviation="1.4"/></filter>
<linearGradient id="shade" x1="0" x2="1"><stop offset=".42" stop-color="#000" stop-opacity="0"/><stop offset=".8" stop-color="#000" stop-opacity=".72"/><stop offset="1" stop-color="#000" stop-opacity=".95"/></linearGradient>
<radialGradient id="limb" r="50%"><stop offset=".62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".7"/></radialGradient>
<filter id="glow"><feGaussianBlur stdDeviation="3"/></filter>`)
}

// 3. Lua: mares escuros, crateras com sombra interna e borda clara, terminador em fase gibosa.
{
  const R = 158
  const r = rng(33)
  let craters = ''
  for (let i = 0; i < 46; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * (R - 10)
    const x = Math.cos(a) * d, y = Math.sin(a) * d, s = 3 + Math.pow(r(), 2.6) * 24
    craters += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(s)}" fill="url(#crat)"/>`
  }
  const maria = [[-46, -52, 50], [26, -26, 40], [-14, 46, 44], [58, 58, 26], [-84, 18, 28]]
    .map(([x, y, s]) => `<ellipse cx="${x}" cy="${y}" rx="${s}" ry="${f(s * .8)}" fill="#000" opacity=".34"/>`).join('')
  files.moon = svg(`
${stars(33, 90, [256, 256, 200])}
<g transform="translate(256 256)">
  <g clip-path="url(#ball)">
    <circle r="${R}" fill="url(#base)"/>
    <rect x="-${R}" y="-${R}" width="${R * 2}" height="${R * 2}" filter="url(#grain)" opacity=".35"/>
    <g filter="url(#mare)">${maria}</g>
    ${craters}
    <rect x="-${R}" y="-${R}" width="${R * 2}" height="${R * 2}" fill="url(#term)"/>
    <circle r="${R}" fill="url(#limb)"/>
  </g>
</g>`, `
<clipPath id="ball"><circle r="${R}"/></clipPath>
<radialGradient id="base" cx="30%" cy="32%" r="85%"><stop offset="0" stop-color="#ececec"/><stop offset=".7" stop-color="#a2a2a2"/><stop offset="1" stop-color="#626262"/></radialGradient>
<radialGradient id="crat" cx="56%" cy="56%" fx="42%" fy="42%" r="50%"><stop offset="0" stop-color="#000" stop-opacity=".08"/><stop offset=".62" stop-color="#000" stop-opacity=".2"/><stop offset=".8" stop-color="#fff" stop-opacity=".05"/><stop offset=".93" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<radialGradient id="limb" r="50%"><stop offset=".75" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>
<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".06" numOctaves="4" seed="4"/><feColorMatrix type="saturate" values="0"/></filter>
<filter id="mare" x="-30%" y="-30%" width="160%" height="160%"><feTurbulence type="fractalNoise" baseFrequency=".04" numOctaves="2" seed="9"/><feDisplacementMap in="SourceGraphic" scale="30"/><feGaussianBlur stdDeviation="5"/></filter>
<linearGradient id="term" x1="0" y1=".1" x2="1" y2="-.1"><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset=".72" stop-color="#000" stop-opacity=".88"/><stop offset="1" stop-color="#000" stop-opacity=".96"/></linearGradient>`)
}

// 4. Estrela: disco granulado, coroa em raios, proeminencias na borda e um brilho horizontal.
{
  const R = 96
  const r = rng(44)
  let rays = ''
  for (let i = 0; i < 64; i++) {
    const a = i / 64 * 360 + r() * 4, len = R + 40 + Math.pow(r(), 2) * 170, w = 3 + r() * 9
    rays += `<path d="M0 ${-w} L${f(len)} 0 L0 ${w} Z" transform="rotate(${f(a)})" fill="#fff" opacity="${f(.05 + r() * .12)}"/>`
  }
  files.sun = svg(`
${stars(44, 70, [256, 256, 240])}
<g transform="translate(256 256)">
  <circle r="250" fill="url(#halo)"/>
  <g filter="url(#rays)">${rays}</g>
  <circle r="${R}" fill="url(#disk)"/>
  <circle r="${R}" filter="url(#gran)" opacity=".18" clip-path="url(#ball)"/><circle r="${R}" fill="url(#limbsun)"/>
  <g fill="none" stroke="#fff" stroke-linecap="round" filter="url(#prom)">
    <path d="M-52 -80 C-60 -100 -40 -104 -36 -88" stroke-width="4" opacity=".45"/>
    <path d="M88 34 C104 34 104 52 92 50" stroke-width="3" opacity=".35"/>
  </g>
  <ellipse rx="230" ry="1.6" fill="#fff" opacity=".22" filter="url(#prom)"/>
</g>`, `
<clipPath id="ball"><circle r="${R}"/></clipPath>
<radialGradient id="halo" r="50%"><stop offset=".3" stop-color="#fff" stop-opacity=".35"/><stop offset=".55" stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<radialGradient id="disk" r="50%"><stop offset="0" stop-color="#fff"/><stop offset=".75" stop-color="#f2f2f2"/><stop offset="1" stop-color="#b8b8b8"/></radialGradient>
<filter id="gran"><feTurbulence type="fractalNoise" baseFrequency=".07" numOctaves="2" seed="12"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="linear" slope="1.6" intercept="-.3"/><feFuncG type="linear" slope="1.6" intercept="-.3"/><feFuncB type="linear" slope="1.6" intercept="-.3"/><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer></filter>
<filter id="rays" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="5"/></filter>
<filter id="prom" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4"/></filter>
<radialGradient id="limbsun" r="50%"><stop offset=".7" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></radialGradient>`)
}

// 5. Buraco negro: sombra, anel de fotons, disco fino na frente e o disco de tras curvado pela lente (acima e abaixo).
{
  const r = rng(55)
  let streaks = ''
  for (let i = 0; i < 30; i++) {
    const rx = 110 + r() * 120
    streaks += `<ellipse rx="${f(rx)}" ry="${f(rx * .13)}" fill="none" stroke="#fff" stroke-width="${f(.5 + r() * 1.8)}" stroke-opacity="${f(.15 + r() * .4)}" stroke-dasharray="${f(30 + r() * 140)} ${f(10 + r() * 50)}" stroke-dashoffset="${f(r() * 200)}"/>`
  }
  const disk = `<ellipse rx="175" ry="${f(175 * .13)}" fill="none" stroke="url(#disk)" stroke-width="30"/>${streaks}`
  files.blackhole = svg(`
${stars(55, 150, [256, 256, 230])}
<g transform="translate(256 256) rotate(-8)">
  <circle r="170" fill="url(#halo)"/>
  <g clip-path="url(#backdisk)" filter="url(#blur1)">${disk}</g>
  <g filter="url(#glow)">
    <path d="M-104 4 A104 100 0 0 1 104 4" fill="none" stroke="url(#lensed)" stroke-width="22"/>
    <path d="M-92 6 A92 70 0 0 0 92 6" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="7"/>
  </g>
  <circle r="76" fill="#000"/>
  <circle r="79" fill="none" stroke="#fff" stroke-width="2" opacity=".95" filter="url(#blur1)"/>
  <g clip-path="url(#frontdisk)" filter="url(#blur1)">${disk}</g>
</g>`, `
<radialGradient id="halo" r="50%"><stop offset=".45" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<linearGradient id="disk" x1="0" x2="1"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#cfcfcf"/><stop offset="1" stop-color="#4c4c4c"/></linearGradient>
<linearGradient id="lensed" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity=".4"/></linearGradient>
<clipPath id="backdisk"><rect x="-260" y="-60" width="520" height="60"/></clipPath>
<clipPath id="frontdisk"><rect x="-260" y="0" width="520" height="70"/></clipPath>
<filter id="blur1" x="-20%" y="-80%" width="140%" height="260%"><feGaussianBlur stdDeviation="1"/></filter>
<filter id="glow" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="3.5"/></filter>`)
}

// 6. Galaxia espiral: bracos logaritmicos de estrelas, poeira e um nucleo brilhante, inclinada.
{
  const r = rng(66)
  let dots = '', glow = ''
  for (let arm = 0; arm < 2; arm++) {
    let d = 'M'
    for (let i = 0; i <= 60; i++) {
      const t = i / 60, a = arm * Math.PI + t * Math.PI * 2.6, rad = 18 + t * 200
      d += `${f(Math.cos(a) * rad)} ${f(Math.sin(a) * rad)} `
    }
    glow += `<path d="${d}" fill="none" stroke="#fff" stroke-width="34" stroke-opacity=".16" stroke-linecap="round"/><path d="${d}" fill="none" stroke="#fff" stroke-width="10" stroke-opacity=".22" stroke-linecap="round"/>`
    for (let i = 0; i < 260; i++) {
      const t = Math.pow(r(), .8), a = arm * Math.PI + t * Math.PI * 2.6 + (r() - .5) * .35, rad = 18 + t * 200 + (r() - .5) * 26
      dots += `<circle cx="${f(Math.cos(a) * rad)}" cy="${f(Math.sin(a) * rad)}" r="${f(.6 + r() * 1.6)}" fill="#fff" opacity="${f((1 - t * .6) * (.35 + r() * .6))}"/>`
    }
  }
  files.galaxy = svg(`
${stars(66, 120, [256, 256, 220])}
<g transform="translate(256 256) rotate(-28) scale(1 .62)">
  <g filter="url(#arms)">${glow}</g>
  ${dots}
  <circle r="70" fill="url(#core)"/>
</g>`, `
<radialGradient id="core" r="50%"><stop offset="0" stop-color="#fff"/><stop offset=".25" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<filter id="arms" x="-30%" y="-30%" width="160%" height="160%"><feTurbulence type="fractalNoise" baseFrequency=".03" numOctaves="2" seed="3"/><feDisplacementMap in="SourceGraphic" scale="22"/><feGaussianBlur stdDeviation="7"/></filter>`)
}

// 7. Cometa: nucleo com coma e duas caudas (poeira curva e ions reta).
{
  files.comet = svg(`
${stars(77, 160)}
<g transform="translate(176 176) rotate(36)">
  <path d="M0 -12 C140 -40 280 -30 440 20 L420 110 C270 60 130 30 0 12 Z" fill="url(#dust)" filter="url(#tail)"/>
  <path d="M0 -4 L460 -10 L460 10 L0 4 Z" fill="url(#ion)" filter="url(#ionblur)"/>
  <path d="M0 -6 C140 -36 280 -30 430 0" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="3" filter="url(#ionblur)"/>
  <circle r="58" fill="url(#coma)"/>
  <circle r="7" fill="#fff"/>
</g>`, `
<linearGradient id="dust" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset=".35" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="ion" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<radialGradient id="coma" r="50%"><stop offset="0" stop-color="#fff"/><stop offset=".2" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<filter id="tail" x="-10%" y="-60%" width="130%" height="220%"><feTurbulence type="fractalNoise" baseFrequency=".012 .06" numOctaves="3" seed="5"/><feDisplacementMap in="SourceGraphic" scale="10"/><feGaussianBlur stdDeviation="5"/></filter>
<filter id="ionblur" x="-10%" y="-200%" width="130%" height="500%"><feGaussianBlur stdDeviation="1.5"/></filter>`)
}

// 8. Planeta com atmosfera: crescente iluminado, nuvens, halo fino no lado do sol e uma lua pequena.
{
  const R = 138
  files.planet = svg(`
${stars(88, 130, [240, 270, 200])}
<g transform="translate(240 270)">
  <circle r="${R + 4}" fill="none" stroke="#fff" stroke-width="12" stroke-opacity=".45" filter="url(#atmo)" mask="url(#sunward)"/>
  <g clip-path="url(#ball)">
    <circle r="${R}" fill="#3c3c3c"/>
    <rect x="-${R}" y="-${R}" width="${R * 2}" height="${R * 2}" filter="url(#clouds)" opacity=".85"/>
    <circle r="${R}" fill="url(#night)"/>
  </g>
  <circle r="${R - .5}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2" mask="url(#sunward)"/>
</g>
<g transform="translate(404 116)">
  <circle r="24" fill="url(#moonlit)"/>
  <circle r="24" fill="url(#moonnight)"/>
</g>`, `
<clipPath id="ball"><circle r="${R}"/></clipPath>
<linearGradient id="sunfade" x1="0" y1="0" x2="1" y2="1"><stop offset=".15" stop-color="#fff"/><stop offset=".55" stop-color="#000"/></linearGradient>
<mask id="sunward" maskUnits="userSpaceOnUse" x="-200" y="-200" width="400" height="400"><rect x="-200" y="-200" width="400" height="400" fill="url(#sunfade)"/></mask>
<filter id="clouds"><feTurbulence type="fractalNoise" baseFrequency=".012 .03" numOctaves="5" seed="21"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="gamma" exponent="2.2" amplitude="1.6"/><feFuncG type="gamma" exponent="2.2" amplitude="1.6"/><feFuncB type="gamma" exponent="2.2" amplitude="1.6"/><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer></filter>
<radialGradient id="night" cx="72%" cy="74%" r="95%"><stop offset=".35" stop-color="#000" stop-opacity=".97"/><stop offset=".62" stop-color="#000" stop-opacity=".55"/><stop offset=".85" stop-color="#000" stop-opacity="0"/></radialGradient>
<radialGradient id="moonlit" cx="30%" cy="30%" r="80%"><stop offset="0" stop-color="#eee"/><stop offset="1" stop-color="#555"/></radialGradient>
<radialGradient id="moonnight" cx="80%" cy="80%" r="80%"><stop offset=".3" stop-color="#000" stop-opacity=".9"/><stop offset=".7" stop-color="#000" stop-opacity="0"/></radialGradient>
<filter id="atmo" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter>`)
}

for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(out, name + '.svg'), text.replace(/\n\s*/g, ''))
  console.log(name, text.length)
}
