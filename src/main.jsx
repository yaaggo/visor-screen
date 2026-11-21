import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './styles.css'
import './lib/env.js'
import App from './App.jsx'

// Nenhum arraste nativo de imagem, link ou texto selecionado (os gestos das cartas usam pointer events).
// Soltar arquivos vindos de fora (foto) continua funcionando.
addEventListener('dragstart', e => { if (!e.target.closest?.('input, textarea, [contenteditable]')) e.preventDefault() })

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
