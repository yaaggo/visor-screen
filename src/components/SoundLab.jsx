import { useState } from 'react'
import { Play, Volume2, VolumeX } from 'lucide-react'
import { SOUNDS, play, setSoundPrefs, soundPrefs } from '../lib/sound.js'
import './lab.css'

// Pagina de sons (#/sons): ouvir cada som do app e para que ele serve.
export default function SoundLab() {
  const [prefs, setPrefs] = useState(soundPrefs)
  const [active, setActive] = useState(null)
  const set = change => setPrefs(setSoundPrefs(change))
  const trigger = name => {
    if (!prefs.on) set({ on: true })
    play(name)
    setActive(name)
    setTimeout(() => setActive(a => a === name ? null : a), 500)
  }
  const all = () => Object.keys(SOUNDS).forEach((name, i) => setTimeout(() => trigger(name), i * 1300))
  return <div className="sound-lab">
    <header>
      <div><b>Sons do Visor</b><small>Sintetizados no próprio app, sem arquivos.</small></div>
      <div className="sound-controls">
        <button onClick={() => set({ on: !prefs.on })} aria-label={prefs.on ? 'Desligar sons' : 'Ligar sons'}>
          {prefs.on ? <Volume2 size={16}/> : <VolumeX size={16}/>}
        </button>
        <input type="range" min="0" max="1" step="0.05" value={prefs.volume} aria-label="Volume dos sons"
          onChange={e => set({ volume: Number(e.target.value), on: true })}/>
        <span className="mono">{Math.round(prefs.volume * 100)}%</span>
        <button onClick={all}>tocar todos</button>
      </div>
    </header>
    <div className="sound-grid">{Object.entries(SOUNDS).map(([name, s]) =>
      <button key={name} className={'sound-card' + (active === name ? ' is-playing' : '')} onClick={() => trigger(name)}>
        <span className="sound-art"><Play size={18}/></span>
        <b>{s.label}</b>
        <small>{s.use}</small>
      </button>)}</div>
  </div>
}
