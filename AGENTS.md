# AGENTS.md — Visor (gta-screen)

Guia de continuidade para agentes (Codex, Claude Code). Leia isto inteiro antes de mexer no projeto.
Ultima atualizacao: 2026-11-18, fase 6 (1.3.0, motor Rust, fotos e multiplas transmissoes).
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
  capture.cjs      fonte selecionada, ciclo de vida do motor Rust e texturas compartilhadas
  capture-rs/      helper Rust (WGC/D3D11) usado pelo motor experimental
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
  lib/nativeCapture.js   recebe VideoFrame do preload e monta uma track WebRTC
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

### Beta de captura Rust (1.3.0-beta.2)

- No desktop, abra **Transmitir**, escolha **Tela** ou **Janela**, selecione uma fonte e abra **Motor de captura**.
  Chromium e o padrao. Para comparar, pare a transmissao antes de trocar para Rust e inicie com a mesma fonte,
  preset, bitrate e numero de espectadores. O icone de atividade mostra o motor usado.
- Rust usa Windows Graphics Capture no adaptador grafico ativo do Electron. Faz a copia e a escala em D3D11
  e entrega texturas compartilhadas ao `MediaStreamTrackGenerator`. O mesmo `ScreenRoom` trata sinalizacao,
  codificacao e entrega WebRTC para os dois motores. O audio segue no mixer existente.
- O tamanho das texturas respeita o preset e a proporcao da fonte. O helper recria o frame pool quando a
  janela muda de tamanho e observa o fechamento da fonte. Numa janela minimizada o WGC pode parar de gerar
  quadros. A sessao continua aguardando o retorno da fonte.
- A beta.2 solicita o consentimento oficial de captura sem borda do Windows e chama
  `SetIsBorderRequired(false)` antes de comecar. Se o Windows recusar, a captura Rust fica indisponivel.
- O helper tem oito texturas reutilizaveis, liberadas apos o Electron acabar de usa-las. Quando a
  transferencia ou a escrita atrasa, a beta.2 conserva so o quadro mais recente pendente em cada etapa.
  O diagnostico Rust mostra `fps WGC`, `fps texturas`, descartes na captura/transferencia e o FPS que
  chegou a track WebRTC. O sender Rust prioriza manter a resolucao do preset sob carga. No palco,
  `fila RTP` mede o atraso medio por pacote no transmissor e `buffer` mede o atraso no espectador.
- A beta.2 usa o perfil `visor-screen-beta` e o instalador `release/beta-2/Visor-Setup-1.3.0-beta.2.exe`.
  O instalador e o portatil da beta.1 seguem em `release/beta/`.
  Entre com a mesma conta para acessar os canais existentes.

Comparacao repetivel no Windows, com Node e Rust MSVC. Abra o Vite e o Electron em terminais separados.

```powershell
npm run native:capture
npm run dev
npm run desktop:dev -- --remote-debugging-port=9333
node scripts/compare-capture.mjs --list
node scripts/compare-capture.mjs --source 'ID ou titulo exato' --preset 1080p60 --mbps 12 --out release/capture-ab.json
npm run dist:win -- portable --config.directories.output=release/beta
```

O script alterna Chromium → Rust → Rust → Chromium, usa sinalizacao local, conta FPS de captura, codificacao,
envio e decodificacao e salva as amostras apos cada rodada. Para usar um Chrome separado, abra o mesmo Vite num
perfil de teste com porta de depuracao local e passe `--viewer-port 9336`. Para medir minimizar/maximizar ou a
partida real, repita a mesma sequencia em ambas as rodadas e compare tambem travamentos e descartes do espectador.

Para comparar com resolucao efetivamente igual, passe `--require-resolution 1920x1080`. O script registra a
resolucao decodificada em cada amostra e sai com erro se alguma estiver fora do alvo. A cena repetivel em
`scripts/fixtures/capture-1080.cjs` abre em tela cheia no monitor principal e grava o ID da fonte em
`release/qa-1080/source.json`. Feche a cena ao terminar.

## Comandos

```
npm install
npm run dev                 # web em http://localhost:5173 (le .env.local)
npm run desktop:dev         # Electron apontando para o vite dev (rode `npm run dev` antes). Usa userData separado
                            # (visor-screen-dev) e nao tem trava de instancia unica: convive com o app instalado aberto
npm run desktop             # build + Electron com dist/
npm run native              # recompila electron/native/bin/visor-audio.exe
npm run native:capture      # compila o helper de captura Rust com o lockfile do Cargo
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

1.3.2 — protecao contra ENOENT no portatil, participantes sincronizados e amplificador de audio 300% (2026-11-18):
- `electron/audio.cjs` verifica `existsSync(visor-audio.exe)` antes de executar ou iniciar capturas e trata eventos
  `error` no `spawn`, evitando `Uncaught Exception: spawn visor-audio.exe ENOENT` quando o Windows/antivirus remove
  temporarios do executavel portatil (`unpackDirName: visor-screen-portable`).
- A lista de participantes em `ScreenChannel` unifica `s.peers` (sala) com `visitors` (diretorio do servidor) e
  usa um container estavel para o portal da sidebar, evitando que transmissores sumam ao entrar no canal.
- Controle de volume robusto nos dois lados com Web Audio API (`GainNode` + `DynamicsCompressorNode` anti-clipping):
  espectador ajusta de `0%` a `300%` (padrao `150%`) no HUD do palco; transmissor ajusta o ganho de envio (`25%` a `300%`,
  padrao `150%`) no painel de Audio.

1.3.1 — presenca, reconexao, indicador de dispositivo e estabilidade de resolucao (2026-11-18):
- A sala e o diretorio usam uma chave por instancia do app/aba. A mesma conta pode transmitir no PC e assistir
  no tablet. O ID do perfil continua identificando a foto; clientes novos reconhecem transmissores da 1.3.0.
- A presenca publica `device: 'mobile' | 'desktop'` (detectando celular e tablet via UA/touch/iPadOS e computador/Electron)
  e exibe um pequeno icone (`Smartphone` ou `Monitor`) ao lado do nome do participante.
- O botao inicial de transmissao (`.share-btn`) na tela inicial da sala fica cinza (`var(--hover)` / `var(--text)`)
  alem de circular quando o painel de configuracao esta aberto (`.island.is-open`), destacando apenas o botao `.island-go`.
- `tuneSender` usa `degradationPreference: 'maintain-resolution'` por padrao em todos os motores (Web, Chromium e Rust)
  e `mungeAnswer` define `x-google-min-bitrate` proporcional ao preset (ate 4 Mbps), evitando que placas AMD ou
  transmissoes via navegador derrubem uma captura 1080p para 336p/1,8 Mbps sob carga de GPU.
- A presenca atual e republicada ao voltar para a aba, recuperar a rede ou reassinar o canal. Falhas e timeouts
  de confirmacao repetem a publicacao mais recente. A captura em andamento continua durante a reconexao.
- Validado em topico isolado no Realtime remoto com dois clientes representando o mesmo perfil: anuncio apos
  timeout simulado, pedido de visualizacao, desconexao real do socket do transmissor, reconexao automatica,
  saida e retorno do espectador e novo pedido para a mesma transmissao. Sem acesso ao tablet fisico.

Fase 6 — Visor 1.3.0:
- No desktop, Rust e o padrao para tela/janela. Chromium continua no seletor. Na web a fonte vem do navegador.
  O helper guarda o quadro WGC mais recente e publica a cada intervalo do preset, preservando a base de tempo
  do sistema. Um atraso nao gera uma rajada de quadros antigos.
- 1080p60 comeca em 25 Mbps em configuracoes novas. Preferencias existentes sao preservadas. A negociacao parte
  do bitrate selecionado e o painel permite aplicar o limite medido. Cada espectador tem controle de congestionamento.
- O canal mostra participantes, nomes, avatares, indicador ao vivo e quem assiste. O espectador pode espiar por
  hover, escolher varias telas e fechar so uma pelo menu de contexto. Cada recepcao tem ICE, retentativa,
  estatisticas e volume independentes. O receptor solicita 80 ms de buffer quando o navegador suporta.
- Fotos em Storage, bucket publico avatars. Cada usuario autenticado grava apenas <uid>.webp, ate 64 KiB.
  Recorte local circular com arraste, setas e zoom; WebP quadrado de 256 px com a mesma mascara na exibicao.
- Guia de uso e publicacao: TUTORIAL.md. Instalador e portatil em release/stable-1.3.0/.
- QA em loopback: janela sintetica com 167 desenhos/s, WGC observado a 155 fps em uma amostra, espectador
  Chrome separado. Duas rodadas finais a 50 Mbps, 18 amostras cada: 1920x1080 em 36/36, medianas
  de envio e decodificacao de 60 fps, bitrate mediano de 26,98 e 28,75 Mbps. Zero descartes e novos
  travamentos nessas rodadas; p95 entre apresentacoes 22 ms. Na rodada anterior ao ajuste de buffer,
  houve um travamento. Dados: release/qa-1080/stable-playout.json. Ainda falta teste de partida entre redes.
- Testados upload e substituicao na conta temporaria, foto de 686 bytes, presenca com foto sob o canal e
  duas fontes WebRTC com encerramento independente.

Feito:
- Fase 1: Supabase + auth anonima, app web completo (servidores, canais, chat, transmissao), deploy Vercel
- Fase 2: app desktop Electron; audio por aplicativo e "sistema sem eco" via helper nativo; dispositivos de video
  (placa de captura) com audio do dispositivo; slider de bitrate em degraus ate 50 Mbps com teste de rede e
  marca de limite; volume do espectador; H264 preferido; correcao de sessao anonima invalida; functions em gru1
- Fase 3: login com senha curta, audio Mudo/Tudo + exclusoes, dropdowns verticais, slider fluido, tooltips do painel
  abrindo para baixo (e acima na linha do bitrate) e sobre as linhas vizinhas
- Fase 4: prioridade de CPU/GPU durante a live no Windows, previa local pausada sem foco, diagnostico nos dois lados,
  teste de upload fora da live e bitrate preservado
- Fase 5 (beta local): seletor de motor para tela/janela no Windows, helper Rust WGC/D3D11, integracao de
  texturas com WebRTC e script de comparacao. Na beta.2, borda desligada por consentimento do Windows,
  filas limitadas no Rust e prioridade de resolucao no envio Rust. A versao estavel daquela fase era a 1.2.0.
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

Validacao da beta Rust:
- Comparacao com resolucao fixa verificada pelo espectador. Mesma cena sintetica em tela cheia no monitor
  principal da RTX 3050, preset 1080p60, teto de 25 Mbps e Chrome 135 headless separado em loopback.
  Seis segundos de aquecimento e sete amostras por motor. As 14 amostras decodificaram a 1920x1080.
  Chromium enviou e decodificou mediana de 34 fps (34–36). Rust enviou mediana de 60 fps (60 em todas
  as amostras) e decodificou mediana de 60 fps (59–61). Nenhum descarte ou travamento nas amostras.
  Dados em `release/qa-1080/ab.json`.
- Loopback com janela WebGL a 180 fps no monitor secundario, Electron 45.3.4 no transmissor e
  Chrome 135 headless separado no espectador. Preset 1080p60, 12 Mbps, sem audio capturado.
  Oito amostras por rodada. Ordem Chromium, Rust, Rust, Chromium.
- Mediana de FPS enviado: 34, 60, 60, 36. Mediana de FPS decodificado: 34, 60, 60, 35.5.
  A resolucao recebida teve altura mediana de 768 px no Chromium e 512 px no Rust. Ambos usaram
  H.264 e sinalizaram limite de banda com esse padrao sintetico. Zero descartes e travamentos medidos.
  O RTCPeerConnection expos o encoder NVIDIA nas rodadas Chromium. Nas rodadas Rust o campo
  `encoderImplementation` ficou ausente. As amostras locais estao em `release/qa-rust/ab-secondary.json`.
- Teste da interface com a janela sintetica: troca pelo seletor, dados Rust no diagnostico, envio
  com a previa pausada, parada da transmissao e preservacao do bitrate.
- Rust produziu video a 1280x720 nos dois monitores. Trocar 1080p60 para 720p30 durante a captura
  diminuiu a imagem e a taxa de texturas para 30 FPS. A janela redimensionada e restaurada voltou a
  produzir video. Minimizada, a track ficou ativa com 0 quadros novos. Fechar a janela encerrou a track.
- O executavel portatil abriu com `file:`, carregou o helper Rust empacotado e recebeu texturas reais
  da janela sintetica.

Validacao da beta.2:
- O Windows retornou `Allowed` para captura sem borda. O helper confirmou a configuracao antes de iniciar.
  Teste isolado da fila do renderer reteve o quadro mais recente quando a escrita ficou ocupada.
- A cena em tela cheia com transicoes (`--transitions`) manteve 1920x1080 em todas as 13 amostras de cada
  motor, a 12 Mbps de teto. Mediana de envio de 54 FPS no Chromium e 60 FPS no Rust. P95 da recepcao
  a apresentacao de 97 ms e 88 ms. Nenhum travamento contabilizado. Arquivos locais
  `release/qa-1080/transitions-before.json` e `release/qa-1080/transitions-after.json`.
- Na cena WebGL pesada em janela no secundario, o Rust enviou 1920x1024 (dimensoes da fonte) em 8/8
  amostras, mediana de 59 FPS. O p95 do buffer medido no Chrome chegou a 116 ms. O Chromium enviou
  1440x768 ou 960x512, mediana de 44 FPS, com p95 de 8 ms no buffer. Dados em
  `release/qa-1080/heavy-after.json`. A queda do Rust para 540p30 relatada na partida ainda precisa de
  uma nova medicao na mesma cena e no mesmo espectador.

Nao verificado:
- Fluidez em uma partida real, FPS do jogo com boost e comportamento quando a GPU fica saturada.
- Transmissao real entre duas maquinas/redes diferentes (so loopback local e mesma maquina)
- Captura `include` de um jogo especifico tocando som (a API e a mesma do modo sistema, que foi verificado)
- Placa de captura fisica (o painel do navegador de teste bloqueia camera)

Comparacao com Twitch (2026-11-18):
- A captura de jogo do OBS, quando usada, pode acessar os quadros do jogo diretamente. Nos testes locais
  do Visor 1.2.0, o FPS ja caia na captura mesmo com H.264 em hardware. Falta comparar em uma partida real.
- O prototipo WGC/D3D11 em `electron/capture-rs` esta ligado ao seletor de motor na beta desktop.
  OBS via WHIP e uma opcao para testar captura de jogo com entrega WebRTC. Um SFU pode reduzir o upload
  do transmissor com varios espectadores, enquanto o buffer de reproducao da Twitch suaviza variacoes de rede com atraso adicional.

Proximos passos sugeridos:
- Comparar os dois motores numa partida real no monitor principal, com o mesmo espectador WebRTC.
  Repetir com tela inteira e com janela. Conferir tambem retomada apos minimizar e carga de GPU do jogo.
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
