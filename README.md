# Visor

Compartilhamento de tela ate 1080p 60 fps com chat, em servidores publicos. Login com usuario e senha curta.

- Web: https://visor-screen.vercel.app
- Desktop (Windows): `npm run dist:win` gera o instalador em `release/` — audio por aplicativo (ex.: so o jogo), placa de captura, bitrate ate 50 Mbps
- Stack: Vite + React, Supabase (Auth, Postgres, Realtime), WebRTC, Electron, Vercel

Durante a transmissao, abra o diagnostico pelo icone de atividade no palco. O transmissor acompanha os FPS de
captura, codificacao e envio. O espectador acompanha a recepcao, a decodificacao e a conexao.

```
npm install
npm run dev          # web
npm run desktop:dev  # app desktop apontando para o dev server
```

Copie `.env.example` para `.env.local` e preencha `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`.

Arquitetura, banco, analise de bitrate, comandos e proximos passos: [AGENTS.md](AGENTS.md).
