import { useEffect, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { play, setSoundPrefs, soundPrefs } from '../lib/sound.js'

// Item de menu para ligar/desligar os sons do app.
export default function SoundToggle({ size = 16 }) {
  const [on, setOn] = useState(() => soundPrefs().on)
  useEffect(() => {
    const sync = e => setOn(e.detail.on)
    addEventListener('visor-sound', sync)
    return () => removeEventListener('visor-sound', sync)
  }, [])
  return <button onClick={() => { const next = setSoundPrefs({ on: !on }); if (next.on) play('drop') }}>
    {on ? <Volume2 size={size}/> : <VolumeX size={size}/>}{on ? 'Sons ligados' : 'Sons desligados'}
  </button>
}
