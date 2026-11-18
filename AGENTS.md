# AGENTS.md — Visor (gta-screen)

Guia de continuidade para agentes (Codex, Claude Code). Leia isto inteiro antes de mexer no projeto.
Ultima atualizacao: 2026-11-18, fase 2 (app desktop, audio por aplicativo, placa de captura, bitrate).
Ao terminar uma sessao de trabalho, atualize a secao "Estado atual".

## O que e

Compartilhamento de tela ate 1080p/60 fps com chat de texto, em servidores publicos.
Login simplificado so com nome de usuario. Sem microfone (decisao do produto); o audio transmitido
e o de aplicativos escolhidos (ex.: so o jogo), o do sistema, ou o de uma placa de captura.
Duas formas de uso, mesmo codigo React:
- **Web**: https://visor-screen.vercel.app (assistir, chat, transmitir com o seletor do navegador)
- **Desktop Windows (Electron)**: instalador em `release/`. Adiciona seletor proprio de tela/janela
  e captura de audio por aplicativo via helper nativo.

Paleta preto/branco/cinza, sem emoji, sem textos longos: so icones (lucide) e motion.
Referencia de motion: https://designbookmark.com/motion

- GitHub: https://github.com/yaaggo/visor-screen (PRIVADO), branch `main`. Releases com os instaladores (v1.0.0)
- Supabase: projeto `visor-screen`, ref `gyqnzjjvugrfpbnfjbrf`, org `yaaggo's`, `sa-east-1`, plano gratuito
- Vercel: projeto `yagos-projects-81a2fc4d/visor-screen` (linkado em `.vercel/`), functions em `gru1`

## Stack

- Vite 8 + React 19 (JS, sem TypeScript). `base: './'` para funcionar em `file://` no Electron
- `@supabase/supabase-js` — auth anonima, Postgres + RLS, Realtime (postgres_changes, broadcast, presence)
- WebRTC nativo, malha 1 -> N (quem transmite abre uma conexao por espectador)
- Electron 45 (Chromium 156) + electron-builder (NSIS + portable)
- Helper nativo C++ `visor-audio.exe` (MSVC, API Application Loopback do Windows)
- Motion: CSS (molas `linear()`, `interpolate-size`) + pouco JS. Sem lib de animacao.
- Todas as deps ficam em `devDependencies` (o bundle Vite ja embute tudo; assim o instalador nao leva node_modules)

## Estrutura

```
index.html, vite.config.js, vercel.json      (vercel.json: headers + regions gru1)
api/turn.js        GET  -> { iceServers } (STUN; TURN Cloudflare se envs existirem). CORS *
api/speed.js       POST -> { bytes } teste de upload. Limite da Vercel: 4,5 MB por corpo. CORS *
electron/
  main.cjs         janela (titleBarOverlay escuro), permissoes de midia, IPC: sources, audio:*, self-pid
  preload.cjs      expoe window.visor (contextIsolation + sandbox)
  audio.cjs        spawn/kill do visor-audio.exe, repassa PCM ao renderer (IPC 'audio:data')
  native/visor-audio.cpp   helper nativo; build.cmd compila em native/bin/
  icon.png, icon.ico
src/
  App.jsx          gate de auth (valida sessao com getUser; sessao invalida e descartada)
  styles.css       todo o visual/motion; .is-desktop aplica regioes de arrastar da janela
  lib/env.js       desktop? (window.visor) e API_BASE (absoluto quando file://)
  lib/supabase.js, lib/route.js
  lib/quality.js   presets, BITRATES, tuneSender(), mungeAnswer() (SDP: x-google-*, Opus estereo 256k)
  lib/screen.js    ScreenRoom: presenca, sinalizacao, peers, stats, uplink (availableOutgoingBitrate)
  lib/sources.js   captureWeb / captureDesktop / captureDevice / listDevices / matchAudio
  lib/appAudio.js  AppAudioMixer: AudioWorklet por app -> MediaStreamDestination (1 track)
  lib/net.js       measureUpload(): 4 envios paralelos de 4 MB, RTT aquecido
  components/Login.jsx, Shell.jsx, TextChannel.jsx, ui.jsx
  components/ScreenChannel.jsx   palco + volume do espectador + ilha
  components/SharePanel.jsx      painel da ilha: fonte, grade de janelas, audio, qualidade, JellySlider
supabase/config.toml   config declarativa MINIMA (so auth). `config push` so altera o que esta aqui
supabase/migrations/20261118112523_visor.sql   schema (ja aplicado no remoto)
```

## Banco (Supabase)

Tabelas em `public`, todas com RLS:

| tabela | colunas chave | regras |
|---|---|---|
| profiles | id (= auth.users.id), username unico case-insensitive, `^[a-zA-Z0-9_.-]{2,20}$` | todos leem; insere/apaga so o proprio |
| servers | id, name (1-32), owner_id -> profiles (on delete set null) | todos leem; dono cria/edita/apaga |
| channels | id, server_id, name (1-24), kind `text`/`screen` | todos leem; dono do servidor cria/apaga |
| messages | id bigint, channel_id, author_id, author_name, body (1-1000) | todos leem; insere so em canal `text`, como si mesmo e com o proprio username; apaga a propria |

- RPC `create_server(server_name)` (security invoker) cria servidor + canais `geral` (texto) e `tela` (tela).
- Realtime em `servers`, `channels`, `messages`.
- Auth: anonimo ligado, 30 logins anonimos/h por IP, site_url = producao.
- Advisor de seguranca avisa "Anonymous Access Policies": esperado, o login do produto E anonimo.

Login: `signInAnonymously()` -> insere `profiles` (23505 = nome em uso). Sair apaga o perfil (libera o nome) + `signOut()`.
Se a sessao salva aponta para usuario removido, o app faz `signOut({scope:'local'})` e cria outra.

## Transmissao

### Fontes (`src/lib/sources.js`)
- **Web, Tela/Janela**: `getDisplayMedia` com `displaySurface`, `systemAudio`. Audio = o que o navegador oferecer
  (aba, ou sistema inteiro ao compartilhar a tela toda no Windows). Nao da para escolher aplicativo no navegador.
- **Desktop, Tela/Janela**: grade propria com miniaturas (`desktopCapturer` no main) e captura via
  `getUserMedia({ chromeMediaSource: 'desktop', chromeMediaSourceId, maxWidth/Height/FrameRate })`.
  Verificado: 1920x1080 a 60 fps.
- **Dispositivo** (placa de captura/webcam, web e desktop): `getUserMedia({ video: { deviceId } })` + entrada de audio
  opcional do proprio dispositivo (sem AEC/AGC/NS, estereo 48 kHz). `matchAudio()` sugere a entrada com nome parecido.

### Audio por aplicativo (somente desktop Windows)
- `visor-audio.exe list` lista processos com sessao de audio (JSON: pid, exe, path, title, active).
- `visor-audio.exe capture <pid>` captura so aquele processo e filhos; `capture <pid> exclude` captura tudo MENOS ele.
  "Sistema" no app = `exclude` do proprio Visor (sem eco do que os espectadores falam/tocam).
- Saida: float32 LE, 48 kHz, estereo, no stdout. Requer Windows 10 build 20348+ / Windows 11.
- `audio.cjs` alinha em frames de 8 bytes e envia via IPC; `AppAudioMixer` toca em AudioWorklet com buffer max ~120 ms
  (descarta excesso para nao acumular atraso) e mixa tudo em uma track. Trocar apps ao vivo nao renegocia o WebRTC.
- Escolher uma janela pre-seleciona o audio do mesmo pid (`winpid <hwnd>`).
- Verificado: 244 blocos de audio em 2,5 s no modo sistema; lista de apps com icone.
- Para recompilar: `npm run native` (precisa VS 2022 Community + Windows SDK 10.0.20348+).

### WebRTC (`src/lib/screen.js`, `src/lib/quality.js`)
- Sinalizacao: canal Realtime `screen:<channelId>`, presence (name, sharing, shareId, preset) + broadcast `signal`
  (`request`, `offer`, `answer`, `ice` com `dir`, `unavailable`; `sid` descarta sinais velhos).
- Codec preferido: **H264** (encoder de hardware), depois VP9, AV1, VP8.
- O transmissor reescreve a SDP de resposta (`mungeAnswer`): `x-google-start-bitrate` (metade do alvo, max 10 Mbps),
  `x-google-max-bitrate=50000`, `x-google-min-bitrate=500` no video; Opus `stereo=1`, `maxaveragebitrate=256000`, `usedtx=0`.
- `tuneSender`: maxBitrate = bitrate escolhido, maxFramerate, `degradationPreference` (60 fps mantem fps, 30 mantem resolucao),
  prioridade alta. Bitrate, qualidade e audio mudam ao vivo (`setBitrate`, `setPreset`, `mixer.set`).
- Espectador: auto-assiste o primeiro transmissor; volume/mudo no HUD; se o navegador bloquear autoplay com som,
  toca mudo e o botao de volume pulsa.
- `window.__room` em `npm run dev` para depuracao.

### Analise de bitrate (por que o teto e 50 Mbps)
Medido em 2026-11-18 nesta maquina (Electron/Chromium 156, loopback local, conteudo sintetico tipo jogo 1080p60):
- Supabase e Vercel nao carregam video (so sinalizacao); o limite e encoder + rede de quem transmite.
- H264 (hardware): alvo 50 Mbps -> sustentou 42-46 Mbps em 1920x1080 a 55-61 fps, sem limitacao.
- Alvo 100 Mbps -> encoder satura em ~55 Mbps (nao usa mais bits). Acima de 50 nao ha ganho.
- VP8 (software) com ruido puro travou em ~13 Mbps e reduziu a resolucao -> por isso H264 primeiro.
- Upload medido do usuario: ~120-128 Mbps (teste paralelo; curl de 1 fluxo subestimou ~18 Mbps).
- Malha 1->N: upload necessario = bitrate x espectadores. O slider sugere `80% do upload / espectadores`.
- Degraus: 2, 3, 4, 6, 8, 10, 12, 16, 20, 25, 30, 40, 50 Mbps. Padrao por preset: 1080p60=12, 1080p30=8, 720p60=6, 720p30=4, 480p30=2.
- No slider: marca cinza = limite da rede (teste de upload antes; `availableOutgoingBitrate` real ao vivo).
  O teste roda sozinho na 1a abertura do painel (cache de 1 h) e ajusta o bitrate para o maximo seguro.
- TURN (se ativado) passa o video pela Cloudflare: 50 Mbps ~ 22 GB/h por espectador retransmitido (free tier 1 TB/mes).

### TURN
Sem TURN, NAT simetrico/CGNAT pode nao conectar. Para ativar (Cloudflare Realtime TURN):
```
npx vercel env add CLOUDFLARE_TURN_KEY_ID production
npx vercel env add CLOUDFLARE_TURN_API_TOKEN production
npx vercel deploy --prod --yes
```

## Comandos

```
npm install
npm run dev                 # web em http://localhost:5173 (le .env.local)
npm run desktop:dev         # Electron apontando para o vite dev (rode `npm run dev` antes)
npm run desktop             # build + Electron com dist/
npm run native              # recompila electron/native/bin/visor-audio.exe
npm run dist:win            # gera release/Visor-Setup-1.0.0.exe e release/Visor-1.0.0-portable.exe
npx supabase db push --remote --yes
npx supabase config diff / config push --yes
npx vercel env ls
npx vercel deploy --prod --yes
```
- Sem CLI global de supabase/vercel: use `npx`. `supabase db push` sem `--remote` tenta Docker local e falha.
- Se o Electron reclamar de binario ausente: `node node_modules/electron/install.js`.
- Vercel tem `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (production/preview) para o build web nao baixar o Electron.
- Teste automatizado do desktop usado nesta fase: abrir o Electron com `--remote-debugging-port=9333` e avaliar JS
  via CDP (`http://127.0.0.1:9333/json` -> `Runtime.evaluate`). Funciona tambem no `release/win-unpacked/Visor.exe`.
- Envs: `.env.local` (VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, VERCEL_OIDC_TOKEN). Nao commitar.

## Estado atual

Feito:
- Fase 1: Supabase + auth anonima, app web completo (servidores, canais, chat, transmissao), deploy Vercel
- Fase 2: app desktop Electron; audio por aplicativo e "sistema sem eco" via helper nativo; dispositivos de video
  (placa de captura) com audio do dispositivo; slider de bitrate em degraus ate 50 Mbps com teste de rede e
  marca de limite; volume do espectador; H264 preferido; correcao de sessao anonima invalida; functions em gru1
- Instaladores gerados em `release/` e publicados em GitHub Releases v1.0.0 (nao assinados: SmartScreen avisa na 1a execucao)
- Repositorio git criado e enviado (privado). Vercel ainda faz deploy pela CLI, nao por push
- Servidor `estudio` pertence ao usuario `yago`; dados de teste removidos

Nao verificado:
- Transmissao real entre duas maquinas/redes diferentes (so loopback local e mesma maquina)
- Captura `include` de um jogo especifico tocando som (a API e a mesma do modo sistema, que foi verificado)
- Placa de captura fisica (o painel do navegador de teste bloqueia camera)

Proximos passos sugeridos:
- Repo e privado: so quem tem acesso baixa o instalador. Para amigos baixarem, tornar o repo publico ou criar um repo
  publico so de releases; depois adicionar botao de download na versao web
- Conectar o repo a Vercel (`vercel git connect`) para deploy automatico por push
- Nova versao do desktop: subir `version` no package.json, `npm run dist:win`, `gh release create vX.Y.Z release/*.exe`
- Auto-update do desktop (electron-updater + GitHub Releases) e assinatura de codigo
- TURN para conectividade em qualquer rede
- SFU (Cloudflare Calls / LiveKit) se precisar de muitos espectadores em bitrate alto
- Sair do canal de tela encerra a transmissao (ScreenRoom vive no ScreenChannel)
- Lista de servidores mostra todos os publicos; sem busca/entrar/sair
- Job de limpeza de usuarios anonimos sem perfil

## Regras de design (pedido do usuario)

- Preto, branco, cinza. Sem cor de destaque ("ao vivo" = ponto branco pulsando; icones de apps em escala de cinza).
- Sem emoji. Sem textos/insights longos. Rotulos curtos so em tooltips (`data-tip`) e `aria-label`.
- Motion inspirado em designbookmark.com/motion: Tab pill/Segmented, Morph island, Magnetic button, Morph popover,
  Copy button, Hold to publish, Loading to success, Springy input, Scramble text, Sidebar collapse, Jelly slider.
- Respeitar `prefers-reduced-motion`.
- Interface em portugues (pt-BR).
