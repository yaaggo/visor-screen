# AGENTS.md — Visor (gta-screen)

Guia de continuidade para agentes (Codex, Claude Code). Leia isto inteiro antes de mexer no projeto.
Ultima atualizacao: 2026-11-18, fase 4 (fluidez e diagnostico da transmissao, v1.2.0).
Ao terminar uma sessao de trabalho, atualize a secao "Estado atual".

## O que e

Compartilhamento de tela ate 1080p/60 fps com chat de texto, em servidores publicos.
Login com nome de usuario + senha de 1 a 4 caracteres (so para poder voltar com o mesmo nome).
Sem microfone (decisao do produto). Audio: Mudo ou Tudo, com lista de apps EXCLUIDOS (o que nao deve sair),
ou o audio de uma placa de captura.
Duas formas de uso, mesmo codigo React:
- **Web**: https://visor-screen.vercel.app (assistir, chat, transmitir com o seletor do navegador)
- **Desktop Windows (Electron)**: instalador em `release/`. Adiciona seletor proprio de tela/janela
  e captura de audio por aplicativo via helper nativo.

Paleta preto/branco/cinza, sem emoji, sem textos longos: so icones (lucide) e motion.
Referencia de motion: https://designbookmark.com/motion

- GitHub: https://github.com/yaaggo/visor-screen (PRIVADO), branch `main`. Instaladores nas GitHub Releases
- Supabase: projeto `visor-screen`, ref `gyqnzjjvugrfpbnfjbrf`, org `yaaggo's`, `sa-east-1`, plano gratuito
- Vercel: projeto `yagos-projects-81a2fc4d/visor-screen` (linkado em `.vercel/`), functions em `gru1`

## Stack

- Vite 8 + React 19 (JS, sem TypeScript). `base: './'` para funcionar em `file://` no Electron
- `@supabase/supabase-js` — auth de e-mail/senha, Postgres + RLS, Realtime (postgres_changes, broadcast, presence)
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
  lib/screen.js    ScreenRoom: presenca, sinalizacao, peers, coleta de stats
  lib/screenStats.js   metricas de captura, codificacao, envio, recepcao e ICE a partir de getStats()
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
- Auth: e-mail/senha, sem confirmacao, anonimo desligado, rate limit sign_in_sign_ups = 30, site_url = producao.

Login (`src/components/Login.jsx`): conta Supabase de e-mail/senha com e-mail sintetico `<nome minusculo>@visor-screen.vercel.app`
e senha `visor-pin:<senha>` (o Supabase exige 6+; o segredo real sao os 1-4 caracteres). Confirmacao de e-mail desligada,
login anonimo desligado. Fluxo: `signInWithPassword`; se falhar, `signUp`; se o signUp disser que ja existe -> "Senha incorreta".
Perfil e criado no primeiro login. Sair = so `signOut()` (o nome continua reservado).
Seguranca: senha de 4 caracteres e fraca de proposito (pedido do usuario); o rate limit do Auth (30 tentativas / 5 min por IP) freia forca bruta.
Em 2026-11-18 todos os usuarios foram apagados na migracao para senha; o servidor `estudio` ficou sem dono (owner_id null).

## Transmissao

### Fontes (`src/lib/sources.js`)
- **Web, Tela/Janela**: `getDisplayMedia` com `displaySurface`, `systemAudio`. Audio = o que o navegador oferecer
  (aba, ou sistema inteiro ao compartilhar a tela toda no Windows). Nao da para escolher aplicativo no navegador.
- **Desktop, Tela/Janela**: grade propria com miniaturas (`desktopCapturer` no main) e captura via
  `getUserMedia({ chromeMediaSource: 'desktop', chromeMediaSourceId, maxWidth/Height/FrameRate })`.
  Verificado: 1920x1080 a 60 fps.
- **Dispositivo** (placa de captura/webcam, web e desktop): `getUserMedia({ video: { deviceId } })` + entrada de audio
  opcional do proprio dispositivo (dropdown vertical de escolha unica) (sem AEC/AGC/NS, estereo 48 kHz). `matchAudio()` sugere a entrada com nome parecido.

### Audio (Mudo / Tudo / exclusoes)
- UI: dropdown vertical no painel (`AudioPicker` em SharePanel.jsx): segmentado Mudo/Tudo + lista de apps com checkbox;
  marcado = NAO sai na transmissao. Exclusoes salvas por nome do executavel (`visor.exclude`), entao valem entre sessoes;
  excluidos que nao estao abertos aparecem esmaecidos para poder desmarcar. Web: so Mudo/Tudo (audio do navegador).
- Calculo dos alvos (`audioTargets` em ScreenChannel.jsx):
  Mudo -> nada; Tudo sem exclusoes -> 1 fluxo `exclude` do proprio Visor (sistema inteiro, sem eco);
  Tudo com exclusoes -> 1 fluxo `include` por app NAO excluido (a API do Windows so exclui 1 processo por fluxo).
  A lista de apps atualiza a cada 3 s enquanto o painel esta aberto ou ao vivo no modo Tudo com exclusoes.
  Apps que comecam a tocar entram sozinhos.
- `audio.cjs` remove da lista os processos com o mesmo executavel do Visor (o audio do Electron roda num filho).
- Verificado (Electron, CDP): app excluido nao capturado, os demais com ~190 blocos/2 s cada.

### Audio por aplicativo (helper nativo, somente desktop Windows)
- `visor-audio.exe list` lista processos com sessao de audio (JSON: pid, exe, path, title, active).
- `visor-audio.exe capture <pid>` captura so aquele processo e filhos; `capture <pid> exclude` captura tudo MENOS ele.
  "Sistema" no app = `exclude` do proprio Visor (sem eco do que os espectadores falam/tocam).
- Saida: float32 LE, 48 kHz, estereo, no stdout. Requer Windows 10 build 20348+ / Windows 11.
- `audio.cjs` alinha em frames de 8 bytes e envia via IPC; `AppAudioMixer` toca em AudioWorklet com buffer max ~120 ms
  (descarta excesso para nao acumular atraso) e mixa tudo em uma track. Trocar apps ao vivo nao renegocia o WebRTC.
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
- Slider (`JellySlider`): durante o arraste o polegar segue o ponteiro sem transicao; ao soltar assenta no degrau com mola.
- No slider: marca cinza = limite da rede (teste de upload antes; `availableOutgoingBitrate` real ao vivo).
  O teste roda sozinho na 1a abertura do painel (cache de 1 h) e atualiza a marca. Ele preserva o bitrate escolhido
  e cancela os uploads ao fechar os ajustes ou iniciar a transmissao. Durante a transmissao, o WebRTC mede a banda.
- TURN (se ativado) passa o video pela Cloudflare: 50 Mbps ~ 22 GB/h por espectador retransmitido (free tier 1 TB/mes).

### Fluidez e diagnostico (1.2.0)

- No Windows, o helper usa `ABOVE_NORMAL_PRIORITY_CLASS` para CPU e solicita `D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH`
  para GPU no processo principal e nos filhos do Visor. O sandbox pode recusar a prioridade de GPU em alguns processos.
  O main enfileira as chamadas e solicita prioridade normal ao parar, sair do canal, recarregar ou perder o renderer.
- A previa do transmissor pausa quando o Visor desktop perde o foco. A captura e os envios continuam.
- A captura desktop continua via `getUserMedia` e fonte escolhida pelo usuario. O Claude comparou o caminho
  `getDisplayMedia` do Electron e uma flag WGC, sem ganho consistente que justificasse a troca.
- Na barra do palco, o icone de atividade abre o diagnostico. Com um espectador conectado, o transmissor ve FPS
  de captura, codificacao e envio, codec, encoder, ms por quadro, bitrate, resolucao, RTT, perda, rota e limitacao
  por espectador. O espectador ve FPS recebido e decodificado, descartes no intervalo, travamentos acumulados,
  codec/decoder, ms por quadro, bitrate, resolucao, perda, jitter, buffer e RTT. `–` indica amostra indisponivel.
- Para investigar uma queda, repita a mesma cena de jogo com um espectador. Anote as duas leituras durante a
  queda. FPS baixo ja na captura indica que os quadros nao chegam ao encoder. FPS de captura alto com codificacao
  baixa direciona a analise para o encoder/custo de processamento. Compare FPS enviado e recebido com perda, RTT,
  buffer e FPS decodificado para avaliar rede e reproducao. Telas estaticas podem produzir menos quadros.
- Use `window.__room.sendStats` no transmissor e `window.__room.stats` no espectador em modo dev.
  `nvidia-smi --query-gpu=utilization.gpu,utilization.encoder --format=csv -l 1` ajuda a correlacionar a carga NVIDIA.
  Para repetir a comparacao, mantenha cena, preset, bitrate, espectadores e limite de FPS do jogo iguais.

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
npm run desktop:dev         # Electron apontando para o vite dev (rode `npm run dev` antes). Usa userData separado
                            # (visor-screen-dev) e nao tem trava de instancia unica: convive com o app instalado aberto
npm run desktop             # build + Electron com dist/
npm run native              # recompila electron/native/bin/visor-audio.exe
npm run dist:win            # gera release/Visor-Setup-<versao>.exe e release/Visor-<versao>-portable.exe
npx supabase db push --remote --yes
npx supabase config diff / config push --yes
npx vercel env ls
npx vercel deploy --prod --yes   # opcional: push em main ja publica
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
- Fase 3: login com senha curta, audio Mudo/Tudo + exclusoes, dropdowns verticais, slider fluido, tooltips do painel
  abrindo para baixo (e acima na linha do bitrate) e sobre as linhas vizinhas
- Fase 4: prioridade de CPU/GPU durante a live no Windows, previa local pausada sem foco, diagnostico nos dois lados,
  teste de upload fora da live e bitrate preservado
- Instaladores Windows em `release/` e nas GitHub Releases (sem assinatura, com aviso do SmartScreen).
  A 1.2.0 usa `Visor-Setup-1.2.0.exe` e `Visor-1.2.0-portable.exe`.
- Repositorio git criado e enviado (privado) e conectado a Vercel: push em `main` = deploy de producao; outras branches = preview
- Servidor `estudio` pertence ao usuario `yago`; dados de teste removidos

Validacao da fase 4 (RTX 3050 Laptop, Electron 45.3.4):
- Captura real de janela no painel secundario do notebook (AMD Radeon integrada) com animacao WebGL a 180 fps,
  preset de captura 1920x1080 a 60 fps, bitrate de 12 Mbps, um espectador WebRTC local, sinalizacao simulada,
  sem audio. Rodadas de 10 amostras. As medianas da captura
  foram 38 e 39 fps com prioridade normal, 39 e 42 fps com prioridade elevada. Minimos de 30 fps sem boost
  e de 36 fps com boost. Codificacao, envio, recepcao e decodificacao acompanharam a captura, com H.264
  NVIDIA, decoder D3D11, sem perda ou descartes nas amostras. O WebRTC tambem reduziu a resolucao enviada
  a 960x512 e acusou limite de banda com o padrao sintetico. O boost ajudou os minimos neste teste curto.
- No monitor principal, ligado a RTX 3050, com a mesma animacao, preset e bitrate, o WebGL usou
  D3D11/NVIDIA e o encoder foi H.264/NVIDIA. Oito amostras por rodada. Mediana de 51 fps de captura nas
  duas rodadas (49–52 normal, 49–51 com boost), com envio acompanhando a captura e sem perda ou descartes
  nas amostras. O WebRTC enviou a 960x516 no fim de ambas as rodadas. As telas usam escalas diferentes
  (1,25 no painel AMD e 1 no monitor NVIDIA), portanto a comparacao envolve os dois caminhos completos.
- O helper ajustou CPU em 5 de 5 processos e GPU em 4 de 5. O teste voltou a prioridade ao normal, alternou
  para o preset 720p30 durante a mesma sessao e verificou o encerramento das tracks e a limpeza das estatisticas.
- A interface do Electron foi testada com dois canais de teste no mesmo renderer e sinalizacao simulada.
  O diagnostico abriu dos dois lados, o envio continuou com a previa pausada, e o teste de rede foi cancelado
  ao iniciar ou fechar ajustes. Um teste de rede concluido preservou o bitrate de 6 Mbps.
- `--enable-features=WebRtcAllowWgcUsingTexture` entregou a track de captura, mas o teste local parou de
  responder antes de entregar amostras RTP. A 1.2.0 usa a configuracao padrao de captura do Electron.

Nao verificado:
- Fluidez em uma partida real, FPS do jogo com boost e comportamento quando a GPU fica saturada.
- Transmissao real entre duas maquinas/redes diferentes (so loopback local e mesma maquina)
- Captura `include` de um jogo especifico tocando som (a API e a mesma do modo sistema, que foi verificado)
- Placa de captura fisica (o painel do navegador de teste bloqueia camera)

Proximos passos sugeridos:
- Se o FPS de captura continuar baixo numa partida real no monitor principal, comparar com um prototipo
  desktop de WGC/D3D11 e encoder de hardware, preservando a interface React. A prova de conceito deve
  medir FPS capturado, codificado e entregue ao mesmo espectador WebRTC no navegador.
- Repo e privado: so quem tem acesso baixa o instalador. Para amigos baixarem, tornar o repo publico ou criar um repo
  publico so de releases; depois adicionar botao de download na versao web
- Nova versao do desktop: `npm version X.Y.Z --no-git-tag-version`, `npm run native` se o C++ mudou,
  `npm run dist:win`. Enviar o commit a `main` e criar a release com os dois executaveis da versao, conferindo
  que o tag aponta para o commit publicado.
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
  Copy button, Hold to publish, Loading to success, Springy input, Scramble text, Sidebar collapse, Jelly slider,
  OTP code (senha), Spring dropdown (listas verticais).
- Selecoes com varias opcoes abrem como lista VERTICAL (dropdown), nao como fileira horizontal de chips (pedido do usuario).
- Respeitar `prefers-reduced-motion`.
- Interface em portugues (pt-BR).
