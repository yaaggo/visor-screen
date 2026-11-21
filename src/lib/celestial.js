// Capa dos servidores sem foto: um de 8 corpos celestes (scripts/celestial.mjs), escolhido pelo id do servidor,
// entao cada servidor tem sempre o mesmo. Data URL (e nao arquivo): funciona em file:// no Electron e o canvas
// da foto em ASCII consegue ler os pixels.
import saturn from '../assets/celestial/saturn.svg?raw'
import jupiter from '../assets/celestial/jupiter.svg?raw'
import moon from '../assets/celestial/moon.svg?raw'
import sun from '../assets/celestial/sun.svg?raw'
import blackhole from '../assets/celestial/blackhole.svg?raw'
import galaxy from '../assets/celestial/galaxy.svg?raw'
import comet from '../assets/celestial/comet.svg?raw'
import planet from '../assets/celestial/planet.svg?raw'

const BODIES = [saturn, jupiter, moon, sun, blackhole, galaxy, comet, planet]
const urls = new Map()

export function celestialFor(id) {
  let h = 2166136261
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  const index = (h >>> 0) % BODIES.length
  if (!urls.has(index)) urls.set(index, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(BODIES[index]))
  return urls.get(index)
}
