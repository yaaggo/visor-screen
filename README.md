# Visor

Compartilhamento de tela ate 1080p 60 fps com chat, em servidores publicos. Login so com usuario.

- Web: https://visor-screen.vercel.app
- Desktop (Windows): `npm run dist:win` gera o instalador em `release/` — audio por aplicativo (ex.: so o jogo), placa de captura, bitrate ate 50 Mbps
- Stack: Vite + React, Supabase (auth anonima, Postgres, Realtime), WebRTC, Electron, Vercel

```
npm install
npm run dev          # web
npm run desktop:dev  # app desktop apontando para o dev server
```

Copie `.env.example` para `.env.local` e preencha `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`.

Arquitetura, banco, analise de bitrate, comandos e proximos passos: [AGENTS.md](AGENTS.md).
