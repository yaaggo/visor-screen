# AGENTS.md — Visor (gta-screen)

Guia de continuidade para agentes (Codex, Claude Code). Leia isto inteiro antes de mexer no projeto.
Ultima atualizacao: 2026-11-21, versao 1.15.1 (replay F9 com um codificador so, clipes em MP4).
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
  clips.cjs        pasta Videos\Visor Clips (salvar/listar/ler/Lixeira) e F9 global do replay
  mini.cjs         janela do miniplayer: segue o cursor, tamanho animado, gruda nas bordas, avisa o cursor sobre o app
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
  lib/replay.js    ReplayBuffer do F9: WebCodecs num worker (replayWorker.js, mediabunny -> MP4); reserva: dois MediaRecorder
  lib/asciiField.js, lib/radar.js, lib/topics.js   campo ASCII do deck, radar de presenca, canais calls:<id> compartilhados
  lib/useAsciiField.js   campo ASCII de fundo (tabuleiro; light nas salas)
  lib/celestial.js       capa dos servidores sem foto (8 SVG em src/assets/celestial, gerados por scripts/celestial.mjs)
  lib/nav.js             de onde a pagina veio (animacao deck <-> clipes)
  lib/net.js       measureUpload(): 4 envios paralelos de 4 MB, RTT aquecido
  components/Login.jsx, Shell.jsx, TextChannel.jsx, ui.jsx
  components/ScreenChannel.jsx   palco + volume do espectador + ilha
  components/SharePanel.jsx      painel da ilha: fonte, grade de janelas, audio, replay, qualidade, JellySlider
  components/MiniPlayer.jsx      miniplayer (janela Electron carta/player / Document PiP / cartao flutuante)
  components/ClipsPage.jsx       pagina #/clips: leque de clipes + player
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

1.15.1 — replay F9 com um codificador so (2026-11-21):
- Antes: dois MediaRecorder codificavam a captura inteira o tempo todo (WebM so comeca no cabecalho e num quadro-chave).
  Agora `ReplayBuffer` (src/lib/replay.js) le a track por `MediaStreamTrackProcessor` (copia da track) e manda os
  quadros a `replayWorker.js` (worker inline em blob, carregado so quando o replay liga): um `VideoEncoder` H264
  `prefer-hardware`, quadro-chave a cada 2 s, fila dos ultimos `seconds` ja codificados (memoria ~ bitrate x (N+2) s).
  F9 monta um MP4 (mediabunny 1.65.2, `fastStart: 'in-memory'`) a partir do quadro-chave certo, sem recodificar:
  clipe de N a N+2 s, duracao e busca corretas, audio AAC (Opus se nao houver AAC). O ArrayBuffer volta do worker por
  transferencia e `clips.cjs` grava com Buffer sobre a mesma memoria; miniatura JPEG feita no worker (OffscreenCanvas).
  Sem WebCodecs/H264 (ou acima de 1920x1088, que o encoder de hardware do Chromium recusa) cai no MediaRecorder antigo.
- Relogio (descoberto medindo): o `AudioEncoder` do Chromium so usa o timestamp do PRIMEIRO AudioData e depois conta
  amostras; os primeiros AudioData do processor vem noutra base e os seguintes ja vem no relogio do worker. Por isso o
  worker guarda "amostra -> tempo de captura" na entrada e da o tempo de cada pacote por ele; track que para de
  entregar dados (salto nos timestamps) recebe silencio codificado. O video usa o timestamp de captura (relogio do
  sistema) com base = menor (chegada - timestamp) dos primeiros 2 s, depois fixa; o quadro vai ao encoder ja com o
  tempo final (`new VideoFrame(frame, { timestamp })`, sem copia). Nao passe `frameRate` ao muxer: ele arredonda os
  tempos para 1/fps (com a track do Rust, que nao informa fps, metade dos quadros a 60 fps saia no mesmo instante).
- Medido (cena release/qa-1080 --detail em tela cheia, 1080p60 H264 NVIDIA a 12 Mbps, espectadores WebRTC locais,
  replay de 12 s para os dois gravadores antigos estarem ativos; dados em release/qa-replay/):
  1 espectador: encoder NVIDIA 10,6% sem replay, 25,2% antigo, 17,3% novo; ms por quadro 7,7 / 10,6 / 8,2;
  CPU 80% / 141% / 115% de um nucleo. 3 espectadores: envio 46,2 / 41-42 / 43,5-43,8 fps; ms por quadro
  10,5 / 15,6-16,0 / 11,5-12,0; encoder 22% / 34% / 29%. Montar o MP4 de 30 s: 70-80 ms no worker; IPC + disco ~130 ms.
- Sincronia (pisca branco + bipe no mesmo quadro, captura da tela): video 28-44 ms depois do audio, estavel no clipe
  todo; o MediaRecorder deu 2-24 ms no mesmo teste. Diferenca vem da base do video por chegada (os relogios de video e
  audio do processor nao tem conversao exposta). No app real o audio passa por helper + IPC + worklet, que o atrasa.
- QA no app (Electron dev, conta temporaria apagada): motor Rust, audio Tudo e Mudo, F9 real do Windows: MP4 de
  30,7 s a 59 fps (intervalos de 16,7 ms), AAC com som, miniatura, aviso "Clip salvo", tocou na pagina de clipes.
  Build de producao em file:// (dist via Electron): o worker inline carregou e devolveu MP4 H264+AAC com miniatura.
  Nao verificado: placa de captura, GPU AMD/Intel, jogo real em tela cheia, F9 no app instalado.

1.15.0 — miniplayer, mesa de clipes, corpos celestes e campo ASCII nas salas (2026-11-21). Um commit por recurso:
- Replay: transmitindo no Mudo (ou dispositivo sem audio), o clipe grava o som do sistema menos o Visor num
  AppAudioMixer so do replay (`ReplayBuffer.addTrack` reinicia os gravadores). Verificado com ffmpeg volumedetect:
  clipes com som tanto no modo Tudo quanto no Mudo. A borda arredondada interna do deck (`.server-hub`) saiu.
- Servidores sem foto: um de 8 corpos celestes (saturno, gigante gasoso, lua, estrela, buraco negro, galaxia, cometa,
  planeta com lua), escolhido por hash do id (`celestialFor`), como data URL (o canvas da foto ASCII le em file://).
  `serverPhotoUrl` devolve sempre uma imagem. Na foto ASCII, `photoMask(..., { cosmic })`: fundo preto = -2 (o campo
  continua), contraste esticado so no corpo, caixa ate 1,9x maior.
- Clipes: cartas com data-z (fisica do deck; antes atravessavam e trocavam devagar por falta dele). Mesa no centro com
  feltro e aro das mesas do tabuleiro, do tamanho de uma carta; carta solta (ou clicada) nela faz a onda do deck e a
  mesa cresce ate 16:9 (mola); puxar o video vira carta e a mesa encolhe; outra carta troca o video (o antigo esmaece).
  Botao de mudo. Deck -> clipes: o leque desce e os clipes sobem um a um; volta: o inverso (`nav.js`, `is-dealing`).
  DeckLab leva a `#/clips-teste` (so dev, Electron).
- Campo ASCII no tabuleiro do servidor e versao light nas salas (6 fps parado, 20 com mouse). Medido na sala 1440x900:
  0,3% de um nucleo parado, 1,5% com o mouse (tempo de JS). Para transmitindo ou com a sala fora da tela.
  `window.__fields` em dev.
- Miniplayer desktop (`electron/mini.cjs`): janela transparente sempre no topo; o processo principal segue o cursor real
  (`getCursorScreenPoint`) a cada 8 ms. Ao levantar uma transmissao a janela abre escondida; quando a carta ficaria cortada
  pela borda (esquerda, direita, topo ou fora por baixo) ela vira a janela sob o cursor (~120 ms); soltar fora cresce ate
  o player onde soltou, dentro da tela e grudando nas bordas. O player arrasta por qualquer ponto (a regiao de arrastar
  antiga nao funcionava na janela do window.open), roda do mouse muda o tamanho (largura em `visor.miniWidth`), duplo
  clique volta. Arrastado sobre o app vira carta, a mesa/mao acende (`ghost`) e soltar devolve a mesa naquela posicao ou
  para de ver (mao). Na mao fica uma carta tracejada do miniplayer (clicar ou arrastar devolve). O 'load' de
  about:blank nunca chega nessa janela: espera-se so readyState (antes eram 1,5 s fixos).
- QA: Electron dev com mouse real do Windows (SetCursorPos/mouse_event) e conta temporaria apagada: arrastar para fora,
  mover, grudar no canto, roda, voltar para a mesa, soltar na mao e botao voltar. Transicoes e mesa de clipes via CDP.
  Nao verificado: miniplayer sobre jogo em tela cheia exclusiva, varios monitores com escalas diferentes, Document PiP no
  Chrome.

1.14.0 — ping, miniplayer, replay F9 e clipes (2026-11-21). Um commit por recurso:
- Foto em ASCII do deck centralizada (mesmo centro da vaga/iniciais) e com tamanho de ~1,15 carta (`photoBox`).
- Ping (`screen.js` ping/onPing, evento broadcast `ping` no canal `screen:<canal>`): Alt+clique num ponto da
  transmissao; x/y normalizados no video com letterbox, limite de 450 ms; toda tela que mostra aquela transmissao
  (inclusive a de quem transmite) desenha onda + nome. Alt+clique nao levanta a carta da mesa. No Electron, Alt
  sozinho nao abre mais o menu escondido (`before-input-event`). Quem transmite com a previa fora da mesa ouve a gota.
- Miniplayer (`MiniPlayer.jsx`, `mini.css`): arrastar uma transmissao da mesa ate a borda da janela (14 px, ou para
  fora) acende a borda com "Miniplayer"; soltar abre. Desktop: janela propria do Electron (`window.open('about:blank',
  'visor-mini')`, liberada no `setWindowOpenHandler`, sem moldura, sempre no topo nivel screen-saver, canto inferior
  direito do monitor, arrasta pela faixa do topo). O Electron 45 expoe `documentPictureInPicture` mas `requestWindow`
  falha com "no window". Navegador: Document PiP; sem ele, cartao flutuante arrastavel. A transmissao continua sendo
  recebida fora da mesa; som (amplificador como no palco), voltar para a mesa, parar de ver; fechar a janela = voltar.
  O fechamento da janela e adiado 1 tique: o StrictMode do dev desmonta/remonta o efeito e fechava a janela.
- Replay (`src/lib/replay.js`, `electron/clips.cjs`): opcao "Replay" no painel (desktop): desligado, 30 s ou 1 min.
  No ar, dois MediaRecorder defasados (reinicio a cada 2N s, defasagem N s); F9 fecha o mais antigo, entao cada clipe e
  um WebM valido de N a 2N s (H264 por hardware quando disponivel; 8 Mbps). F9 e atalho global (funciona com o jogo
  em foco), registrado so enquanto o replay esta armado. Arquivos em `Videos\Visor Clips` (`.webm` + `.jpg` miniatura
  via ImageCapture + `.json` com duracao/origem). Aviso "Clip salvo" e chip F9 na propria transmissao. Apagar = Lixeira.
- Clipes (`ClipsPage.jsx`, `clips.css`, rota `#/clips`, botao ao lado da marca no deck, so desktop): leque de cartas
  com miniatura, hora e duracao, mais novos a esquerda, 7 por pagina; arrastar para cima (ou clicar) leva ao player
  do centro (play/pausa, barra, tempo, mostrar na pasta, Lixeira, fechar). A duracao do WebM do MediaRecorder e
  recuperada pulando ao fim no `loadedmetadata`.
- QA (Electron dev 1440x900 via CDP, script local de screenshots; duas contas temporarias no Supabase real, apagadas):
  ping de A chegou a B com nome e ponto; miniplayer abriu (420x236, video tocando), "voltar" devolveu a mesa;
  F9 real pelo sistema (SendKeys) salvou 3 clipes (54 s, 26 s, 16 s); ffmpeg decodifica o WebM inteiro (avisos de
  dts repetido do MediaRecorder, sem efeito); pagina de clipes: arrastar para o player tocou o clipe. Paginas de
  teste (#/deck-teste, #/mesa-teste) sem erros. Nao verificado: F9 com um jogo real em tela cheia, miniplayer sobre
  jogo em tela cheia exclusiva (so funciona em janela/sem borda), Document PiP no Chrome, custo do replay na GPU.

1.13.0 — campo ASCII, foto em ASCII e radar no deck (2026-11-21):
- `src/lib/asciiField.js`: canvas atras do deck com grade de caracteres (` .·:-=+*#`, celulas 12x14). Lente e rastro do
  mouse, onda ao tocar o fundo e ao entrar no servidor, fluxo + vaga desenhada em caracteres ao arrastar uma carta,
  caracteres que embaralham e somem na lixeira, marca VISOR respirando no centro e iniciais da carta em foco (scramble).
  Custo no DeckLab a 1920x1080 (tempo de JS): 2,8% de um nucleo parado (12 fps), 5,6% com o mouse (30 fps); a textura
  fica numa camada atualizada so nas celulas que mudam. Para sem foco, com a aba oculta e durante a propria
  transmissao (`call.live`); reduced motion = estatico (nao verificado).
- Foto do servidor em ASCII (`photoMask`): um pixel por celula, luminancia com contraste entre os percentis 5 e 95,
  quadrado arredondado como contorno; tamanho = espaco livre entre o topo e o deck (18 linhas numa janela pequena,
  ~28 em 1080p). Cache por URL+tamanho e pre-carga das fotos. O bucket `avatars` responde `Access-Control-Allow-Origin: *`
  (pixels legiveis); foto real lida em 277 ms com rede. Sem foto ou falha = iniciais. `serverInitials` (ui.jsx) ignora
  espacos e nao corta emoji ao meio (tambem na carta).
- Radar (`src/lib/radar.js`): com o deck aberto, ouve sem publicar a presenca `calls:<id>` de todos os servidores e
  passa `activity` ({ people, live }) ao ServerHub: ponto ao vivo na carta, anel lento a cada 2,4 s e contagens acima
  da foto/iniciais. A propria instancia nao conta.
- `src/lib/topics.js`: canais `calls:<servidor>` compartilhados (diretorio da call, tabuleiro e radar). Motivo: o
  realtime-js 2.119 devolve o MESMO canal para o mesmo topico; fechar e abrir o topico no mesmo commit entregava um
  canal saindo, cujo `subscribe()` nao faz nada (ja podia ocorrer ao entrar numa call de outro servidor com uma call
  ativa). Agora: um canal por topico, fecha 1,5 s apos o ultimo usuario, reabre 3 s apos CLOSED/erro e reenvia
  'SUBSCRIBED' + estado a quem entra. Quem faz `track` faz `untrack` ao sair (o canal pode seguir aberto).
  `window.__topics` em dev.
- QA com duas contas temporarias no Supabase real (localhost e [::1], apagadas no fim): B na mesa -> deck de A com
  { people: 1, live: 0 }; B transmitindo (track de canvas via `window.__room.startShare`) -> live 1, carta com ponto;
  deck -> servidor -> deck sem recarregar reaproveita o canal (1 topico, 1 usuario). Nao verificado: reabertura apos
  CLOSED real, Electron instalado, GPU durante jogo, reduced motion. DeckLab: `#/deck-teste` (amigos tem foto gerada).

1.12.2 — app sem comportamento de site e foco das cartas estavel (2026-11-21):
- `body` com `user-select:none` e `-webkit-user-drag:none`; so campos e o texto das mensagens (`.msg-main p`)
  sao selecionaveis. `main.jsx` cancela todo `dragstart` nativo fora de campos (os gestos usam pointer events;
  soltar arquivo de fora na foto continua). Antes dava para selecionar titulos e arrastar capa+nome do servidor.
- `fanPhysics.js`: histerese. Ao abrir espaco as cartas se movem sob o ponteiro parado e o Chromium reavalia o hover,
  entao no vao/borda entre duas cartas o foco alternava sem parar. Agora, apos cada troca, a proxima so acontece
  depois de o ponteiro andar 10 px (`MOVE`), relendo o alvo no ponto atual.
  Medido no navegador do app (Chromium real) no DeckLab: versao antiga em x=342 alternou gta rp/estudio 5 vezes em 1 s
  com o mouse parado; nova: 0 trocas em 3 s nos mesmos pontos. O Chrome headless nao reproduz (nao reavalia o hover).

1.12.1 — carta endireita a caminho do centro (2026-11-21):
- Arrastando uma carta do deck, a inclinacao do leque diminui conforme ela se aproxima do centro (smoothstep sobre a
  distancia, reta a 80% do caminho) e no voo final termina em 0. Se voltar para a mao, retoma o angulo do leque.
  Medido via CDP no DeckLab: -6deg no deck, 0deg a 80% do caminho, sem salto ao encaixar.

1.12.0 — leque sem atravessar, call no centro do deck (2026-11-21):
- `src/lib/fanPhysics.js` reescrito. Ordem base: a carta mais a esquerda por cima, a + por baixo (pedido do usuario,
  inverte a 1.11.0). So a carta em foco muda de z. As cartas que ficam por cima dela na ordem base abrem espaco
  (`--part` somado ao `left`, transicao de .2s); o espaco e dividido: elas vao metade para um lado e a carta em foco
  (com as que estao abaixo dela) a outra metade. Um z-index so muda quando nenhuma carta sobreposta troca de lado
  (geometria real: translate/rotate/scale/transform/left atuais + SAT, a cada quadro); fallback de 420 ms.
  A carta que perde o foco desce primeiro (enquanto ainda esta livre) e so depois o leque se reorganiza.
- QA objetivo (CDP, Chrome headless 9336): a cada quadro mede a sobreposicao (SAT) e a ordem de cada par de cartas;
  troca de ordem com sobreposicao > 3 px = atravessou. Deck (1400x880 e 900x620) e mao de 12 cartas com varreduras
  nos dois sentidos, saltos e saida rapida: 0 trocas. Com reduced motion (troca instantanea) o detector acusa 48.
- Deck com call em andamento: a carta do servidor da call fica no centro (`.deck-callcard`), fora da mao, com o nome
  da sala e, transmitindo, icone de radio + ponto pulsando. Clicar volta para a sala; arrastar ate a faixa do deck
  (ou Delete) desliga e a carta volta voando para o seu lugar na mao. Colocar outra carta no centro abre aquele servidor e a
  call continua (como antes). DeckLab: `#/deck-teste?call` e `#/deck-teste?live`.
- Voo carta -> capa: a arte da carta cresce ate ocupar a moldura (sem margem e legenda) antes da troca; com foto
  nao aparecem mais duas imagens.
- Entrar na call vindo do deck mostrava o tabuleiro vazio e depois saltava para a sala (a lista de canais ainda
  carregava). O Shell usa o proprio canal da call e guarda os canais por servidor; no deck pre-carrega os canais
  de todos os servidores, entao o tabuleiro abre ja com as mesas.
- QA no app real (dev) com conta temporaria, apagada no fim: entrar com foto, sala, voltar (carta no centro),
  retomar, outro servidor durante a call, desligar arrastando. Nao verificado: o indicador "transmitindo" com uma
  transmissao real (so no DeckLab) e o Electron instalado com duas contas.

1.11.0 — lixeira dupla, fisica das cartas e foto na carta (2026-11-21):
- Lixeira do deck: servidor proprio = apagar (icone lixeira); servidor de outra pessoa = sair (icone porta).
  O modo e trocado direto no DOM (`data-mode`), sem re-render: um `className` controlado pelo React apagava a
  classe `visible` adicionada no gesto. Sair = `delete` em `server_members` (migracao 20261121120000_leave_server.sql,
  politica "leave own memberships", aplicada no remoto; testada em transacao revertida: outro usuario 0 linhas, o proprio 1).
- `src/lib/fanPhysics.js` (deck e mao da sala): uma carta nunca atravessa outra. Quando a ordem entre duas cartas
  sobrepostas inverte, a que vai ficar por baixo desliza para o lado (afastando-se), a outra sobe, a ordem troca no
  pico (190 ms) e a desviada volta por baixo. Desvio proporcional a sobreposicao, teto 22% da largura / 30 px.
  Intencao de hover de 70 ms (varrer o leque nao puxa as cartas do caminho). Ao tirar o mouse, `.is-settling` mantem
  o leque aberto ate a carta voltar para baixo das vizinhas; so entao o leque fecha. No deck a sobreposicao e
  calculada no leque aberto (`overlapAt`), senao cartas distantes desviavam durante a abertura.
- Ordem das cartas sempre da esquerda para a direita, com a carta + por cima (pedido do usuario; substitui a regra da 1.6.2).
  O z-index de hover saiu do CSS: o controlador aplica `style.zIndex` na carta com prioridade.
- Carta do perfil (tabuleiro) e cartas de pessoas na mao: a foto ocupa todo o quadro interno. Imagens nunca sao
  arrastadas sozinhas (`draggable=false` + `-webkit-user-drag:none`): qualquer ponto da carta arrasta a carta.
- QA: `npm run dev` e abrir `#/deck-teste` (DeckLab.jsx, so em DEV, sem login; servidores proprios e de outros).
  Gravacao quadro a quadro via CDP num Chrome headless (`--remote-debugging-port=9336`): a janela do Electron, se
  ocluida, para de renderizar e o `Input.dispatchMouseEvent` trava. Deck e mao com 8 cartas verificados.
  Nao verificado: sair de um servidor real pela interface com duas contas.

1.10.3 — reverte o Visor oculto na captura (2026-11-19):
- Pedido do usuario: o Visor deve continuar aparecendo na captura. `setContentProtection`/`capture:hide-self`
  removidos. Mantidas as otimizacoes sem efeito visual da 1.10.2 (carta plana apos virar, esmaecimento por
  camada, pulsacao por opacidade).
- Investigacao do FPS menor com o Visor em foco (nesta maquina, RTX 3050, cena WebGL saturando a GPU,
  captura de tela inteira pelo motor Rust, envio H264 local, 8 amostras por estado):
  com o Visor em foco e a propria previa tocando, a cena caiu para 45-47 fps contra 52-57 com a previa
  escondida e 53-54 com a cena em foco; a tela capturada mudava 70-79 vezes/s (o espelho da previa) contra
  ~50. Com GPU folgada (cena leve) nao houve queda em nenhum estado (60/60). O boost de prioridade nao mudou
  o resultado de forma consistente. Causa: a previa 1080p60 da propria transmissao so toca com o Visor em foco
  (pausa no blur desde a 1.2.0) e disputa a GPU com o jogo; capturando a tela onde o Visor aparece, ela ainda
  vira um espelho que gera quadros extras. Em PCs mais fracos o efeito e maior. Tambem pode somar: jogos que
  limitam o proprio FPS quando perdem o foco. Nada foi alterado no app por essa investigacao.

1.10.2 — desempenho com o Visor na tela capturada (2026-11-19):
- Relato: transmissao travando quando o proprio Visor aparecia na tela capturada; outras fontes fluidas.
  Causas: efeito espelho (a propria transmissao aberta na mesa, capturada de novo a cada quadro) e o custo
  de composicao da mesa (carta 3D com perspective/preserve-3d/backface sobre o video, filter nas
  transmissoes esmaecidas, pulsacao de box-shadow infinita na CallCard).
- Correcoes: durante a transmissao no desktop, `win.setContentProtection(true)` (IPC `capture:hide-self`)
  tira a janela do Visor das capturas de tela; testado neste Windows: a janela some e aparece o que esta
  atras (nao fica preto). A carta vira `is-flat` apos virar (sem 3D), o esmaecimento e uma camada por cima e
  a pulsacao da CallCard anima so opacidade. Efeito colateral: com a transmissao ativa, prints do Windows
  tambem nao mostram o Visor.
- Nao medido na maquina da amiga; nao houve comparacao de FPS antes/depois.

1.10.1 — transicoes do tabuleiro (2026-11-19):
- Causa do voo carta -> capa no lugar errado: `.shell` anima `grid-template-columns`; ao trocar de tela a
  coluna lateral ia de 232 a 0 e o conteudo deslizava durante a animacao. Agora `.shell.snap` (dois quadros
  apos mudar servidor/canal) desliga a transicao; so recolher a lateral anima. `.in-hub` tambem tem coluna 0.
- Entrar na mesa: carta pousa, `body.board-entering` esconde sala/lateral/barra, a sala monta sob a mesa e a
  mesa se expande ate o `.table-felt` medido apos montar; ao encaixar, `board-revealing` mostra a sala e a
  lateral desliza. Sair: o Shell mede o `.table-felt` antes de navegar e o tabuleiro encolhe dele ate a mesa
  (escondida ate pousar); as outras mesas entram com atraso.
- Mesas com raio 30px. Onda do deck no body (centrada na carta) e abertura em 470 ms: a carta da um impacto,
  sobe e acende enquanto a onda passa, e a onda termina por cima da transicao para o tabuleiro.

1.10.0 — tabuleiro do servidor (2026-11-19):
- Servidor sem canal aberto = `ServerBoard` (board.css): cada canal de transmissao e uma mesa (cartas de quem
  transmite, plateia nas bordas, "vazia"), "Nova mesa" para o dono (botao direito apaga) e a sua carta embaixo.
  Jogar a carta numa mesa (ou clicar) pousa a carta, as outras mesas recuam e a mesa se expande ate a sala.
  Ao desligar, o Shell guarda a mesa de onde voce saiu (`returning`) e a sala encolhe ate ela com a carta voltando.
- A lateral e a barra do canal so existem com um canal aberto (`.shell.is-board` = coluna 0). A capa do
  servidor no tabuleiro usa `rail-item is-active`, alvo do voo carta -> capa vindo do deck.
- Sons novos `enter`/`exit` (entrar e sair da call), tambem em `#/sons`. Call em outro servidor aparece como
  CallCard no canto do tabuleiro.

1.9.0 — zoom, sons e avisos de mensagens (2026-11-19):
- Zoom no desktop: o Ctrl+Plus do menu padrao nao dispara no ABNT2. `before-input-event` trata Ctrl + '='/'+'/
  '-'/'0' (e teclado numerico) e `zoom-changed` (Ctrl + roda), nivel entre -3 e 4. Testado com teclas reais.
- `src/lib/sound.js`: 15 sons sintetizados em Web Audio (onda, gota, bolha, levantar/pousar/voltar carta,
  virar, sem conexao, ao vivo, fim, nova transmissao, entrou, saiu, abrir painel, papel amassado), com
  compressor, volume e liga/desliga em localStorage `visor.sound`. Menu do perfil e da central: "Sons ligados".
  Pagina para ouvir: `#/sons` (SoundLab, sem login, tambem em producao).
- Mensagens da call: gota ao chegar; nao lida quando o chat esta fechado, a call esta em outra tela ou a janela
  sem foco. Aviso: contador no titulo, ponto no icone da aba (web), selo na carta da call e `flashFrame` no
  desktop (IPC `attention`).

1.8.0 — mesa de cartas na sala (2026-11-19):
- `CardTable.jsx` + `table.css` substituem StreamGrid, a coluna de avatares, a previa flutuante e a ilha.
  Mao (base): uma carta por pessoa transmitindo fora da mesa + carta "Transmitir". Mesa: transmissoes em
  posicoes calculadas (`gridLayout` maximiza o maior 16:9; `spotLayout` = destaque grande + faixa lateral
  ou inferior, demais esmaecidas). Arrastar mostra a posicao tracejada e o chip "Destaque"; segurar uma
  transmissao (260 ms ou arrastar) a transforma em carta: soltar na mao para de ver, na mesa reposiciona.
  A carta pousa virada (verso = conectando) e vira com o video; sem video em 15 s o verso mostra "sem conexao".
- A carta "Transmitir" cresce ate virar o painel (`ShareSheet`, SharePanel real dentro) e encolhe ao fechar.
  Ao vivo, ajustes/parar ficam na barra do Stage (`tools` prop) da propria transmissao.
- Plateia via portal em `#call-head-slot` (barra do canal, canto superior direito). Chat fechado: mensagens
  novas aparecem 6 s sobre a mesa e contam no botao do chat.
- Lateral: `ChannelCrowd` (mini leque de cartas de quem transmite + avatares de quem assiste) e `CallCard`
  no rodape (pulsa ao vivo, desligar).
- Mesa de teste: `npm run dev` e abrir `#/mesa-teste` (TableLab.jsx, so em DEV, sem login): transmissoes
  simuladas por canvas, atraso, falha, espectadores, mensagens. Paginas com Supabase simulado em
  `release/table-real.html` e `release/side180.html` (fora do git).
- Nao verificado: transmissao real entre dois PCs com a mesa nova. O destaque e so visual (a rede recebe
  as demais na mesma qualidade).

1.7.3 — botao de atualizacao clicavel (2026-11-19):
- O Electron aplica `-webkit-app-region` na ordem do documento: um `no-drag` que vem ANTES de uma barra
  `drag` perde para ela, e o Windows trata o clique como arrastar janela. O `UpdateButton` ficava antes de
  `.hub-titlebar`/`.main-head`; agora e um portal no fim do `body`. Testado com clique real do SO
  (SetCursorPos + mouse_event) numa janela com titleBarOverlay: posicao antiga nao recebe, nova recebe.
- Quem esta na 1.7.0-1.7.2 nao consegue clicar no icone: instale a 1.7.3 pelo instalador uma vez.
  Para elementos novos sobre barras de arrastar, renderize-os depois delas no DOM.

1.7.2 — sala que se recupera do limite de presenca (2026-11-19):
- Primeira partida real entre redes (Juazeiro/Petrolina): o transmissor sumiu da sala. O Supabase registrou
  `ClientPresenceRateLimitReached` para a conta dele e FECHOU o canal da sala; o app nao reabria, entao o
  diretorio mostrava "transmitindo" mas nenhum pedido de video chegava. Nao era NAT/TURN.
- `presencePublisher` agrupa rajadas (250 ms), ignora estado identico ao confirmado, limita a 5 tracks/10 s,
  repete apos falha e confere a propria presenca a cada 10 s. `ScreenRoom` reabre o canal (CLOSED/CHANNEL_ERROR
  e watchdog de 5 s, backoff ate 15 s); o diretorio em Shell tambem reassina.
- Incidente: o primeiro commit da correcao apagou send/onPresence/onSignal/startShare do ScreenRoom (substituicao
  de bloco grande) e quebrou a web por ~10 min (cada clique abria uma captura nova). Restaurado no commit seguinte.
  Teste com contas reais: presenca nas duas salas, rajada de 20 tracks, sinal entregue, canal fechado reaberto.
- TURN continua desligado (`/api/turn` so devolve STUN). Redes com CGNAT dos dois lados ainda podem falhar.
- Diagnostico de rede real (2026-11-19, mesmo provedor nos dois lados): o yago esta atras de CGNAT (saltos 172.29.x
  apos o roteador ZTE) e estava com IPv6 DESLIGADO no Windows (so Teredo 2001::). Com o Haroldo (IPv6 nativo), ICE
  ficava em `checking`: 8 envios por par e 0 respostas. Ativar `ms_tcpip6` no Wi-Fi deu IPv6 nativo e a transmissao
  passou a funcionar. Celular em dados moveis assistindo o PC funcionou sem TURN.
  Para diagnosticar: abrir o Visor com `--remote-debugging-port=9333`, achar o ScreenRoom pela fibra React a partir de
  `.share-btn` e ler `getStats()` dos `candidate-pair` (requestsSent/responsesReceived). Antes de mexer em TURN, peca
  aos dois lados para conferir IPv6 (test-ipv6.com / Protocolo IP Versao 6 nas propriedades do adaptador).

1.7.1 — animacoes e atualizacao em segundo plano (2026-11-19):
- Onda de choque: escala e opacidade em animacoes separadas (uma curva de crescimento e fade longo),
  zerando antes de abrir o servidor. Antes cada etapa reiniciava a curva e o fim era cortado.
- Carta do centro -> capa da lateral (`coverFlight` em Shell.jsx): a moldura anima geometria real
  (left/top/width/height/raio) enquanto a carta some e a capa aparece. O destino e medido sem a entrada
  deslizante da lateral, e a capa nao usa mais a animacao `pop` (era o salto/resize brusco no fim).
- Lixeira: uma camada clara sobe pela carta durante os 1,5 s sobre a lixeira.
- Atualizador: ao achar versao nova, o main baixa e verifica o instalador em segundo plano; o icone so
  aparece quando esta pronto. O clique roda `/S --force-run`, fecha e o instalador reabre o Visor.
- Testado no app instalado: 1.7.0 -> 1.7.1 pelo botao (download ~12 s, fechou, instalou e reabriu na 1.7.1
  em ~30 s). Fluxo em segundo plano da 1.7.1 validado contra o canal real (pronto em ~3 s, segunda checagem `ready`).
- `publish-update.ps1` apaga cada objeto antes de enviar (o CLI nao sobrescreve). O bucket e do plano gratuito
  (~120 MB por versao): apague as partes de versoes antigas depois de publicar.

1.7.0 — atualizacao automatica, lateral nova e lixeira do deck (2026-11-19):
- Desktop empacotado consulta `desktop-updates/latest.json` (bucket privado do Supabase, leitura para
  autenticados) a cada 15 min e ao voltar a rede. Havendo versao maior, um icone discreto aparece no canto
  superior direito; o clique baixa o instalador em partes de 24 MB, confere SHA-256, roda `/S --force-run` e fecha.
  Publicar: `npm run dist:win` e depois `pwsh scripts/publish-update.ps1` (usa `npx supabase storage cp`).
  O GitHub continua recebendo a release, mas o app nao depende do repo privado.
- A barra de servidores saiu: a troca e so pelas cartas. A lateral tem a capa do servidor (quadrado
  arredondado, volta ao deck), o nome, os canais e no rodape o status da call e o menu do perfil
  (trocar foto, sair). Botao direito na capa (ou `...`): trocar foto, trocar nome, copiar codigo, criar canal.
- Deck: segurar um servidor proprio mostra a lixeira a direita; manter 1,5 s sobre ela dobra a carta e apaga.
  Soltar antes cancela. A carta + so fica acima das outras no hover e nao muda de estrutura ao arrastar.
- QA: `release/check170.cjs` (Electron + `release/deck170.html` no Vite 5199) cobre ordem das cartas,
  cancelamento em 450 ms, exclusao em 1650 ms, menu da capa, menu do perfil e retorno ao deck.

1.6.2 — no leque, as cartas dos servidores ficam acima da carta +, inclusive
ao focar o +. Cada pagina agrupa ate tres servidores e a carta de adicionar.

1.6.1 — a carta fica fora da mao ate concluir a entrada. A carta de adicionar
se transforma no seletor central e so recolhe ao cancelar. A onda de entrada
e uma iluminacao radial em duas camadas atras das cartas, ate as bordas.

1.6.0 — deck de servidores (2026-11-19). ServerHub usa cartas em leque na base da tela,
com as molas de abertura, elevacao e escala do Fan Cards (220/18, 420/20, 420/22).
Clique ou arraste ao centro para entrar; fora do alvo, a carta volta para o deck.
A carta + abre Criar/Entrar. O RPC de entrada aceita nome exato sem diferenciar maiusculas
ou codigo de convite. Nomes duplicados exigem o codigo. O icone ativo retorna pelo centro.
QA Electron com gestos de ponteiro, clique, cancelamento, criacao e retorno; RPC verificado
em transacao revertida para nome, convite e nome duplicado.

1.5.1 — a lateral mostra nome e foto abaixo de cada canal, inclusive o canal selecionado.
A propria sessao entra imediatamente pelo estado da call; o diretorio fornece os demais
participantes por instancia e nao duplica a pessoa local quando chega a confirmacao.

1.5.0 — servidores com fotos e canais de transmissao (2026-11-19):
- No servidor, a barra mostra todas as participacoes. O icone ativo retorna ao hub com transicao inversa.
  Entrar em outro servidor abre a selecao de canais. A sala em andamento continua ate escolher outra ou desconectar.
- Novos servidores recebem apenas tela. Canais novos sao de transmissao e mensagens novas pertencem ao
  chat da call. O historico dos canais antigos de texto permanece no banco, fora da interface.
- O dono troca a foto no cabecalho do servidor. Recorte WebP 256 px / 64 KiB, politica de escrita por dono e
  revisao em servers para invalidar cache. Migracao 20261119113603 aplicada no projeto remoto.
- Tooltips usam popover na camada superior. A grade mede o espaco disponivel e escolhe a quantidade de colunas.
  Avatares laterais maiores. O hover de uma tela ja em exibicao dispensa a segunda reproducao de video.
- Diagnostico do espectador preserva a amostra da ultima pausa contabilizada pelo WebRTC. O loopback
  historico pesado registrou captura Rust a 60 FPS e codificacao minima de 41 FPS; nao reproduz a rede da amiga.
- QA no Electron com Supabase real: dois servidores, chat de call, upload e exibicao de foto na barra e na
  central, tooltip na camada superior, retorno animado, call mantida ao trocar servidor e grade com quatro
  videos sinteticos em 920x540 e 320x640.

1.4.1 — central minimalista. Apos login, a rota inicial monta apenas a marca Visor
(com menu de conta) e o grupo central de servidores com o mais branco. Criar/entrar
transforma o controle no icone do servidor, revela o mais a direita e leva o icone
para a barra do servidor selecionado. Clicar nesse icone retorna a central.

1.4.0 — central de servidores e continuidade da call (2026-11-18):
- A central lista servidores criados pela conta ou adicionados por codigo de convite. O mais se transforma
  em Criar/Entrar. O codigo de dez caracteres pode ser copiado no cabecalho do servidor.
- A migracao 20261119021539_server_membership.sql esta aplicada no Supabase. O servidor antigo foi removido.
  As regras de leitura de servidores, canais e mensagens exigem propriedade ou participacao.
  O diretorio e a sala usam Realtime privado com autorizacao por topico.
- Shell mantem ScreenChannel montado durante a navegacao. O indicador no canto inferior esquerdo volta
  para a call; o telefone desconecta. Entrar em outro canal de tela troca a call.
  Cada canal de tela usa seu proprio channel_id para o chat lateral. O palco vazio tem moldura e uma
  lista recolhivel de avatares. Sem microfone.
- QA web no Chrome com duas contas temporarias: criacao, entrada por codigo, presenca privada de ambos
  os papeis, mensagem da call separada de geral, retorno e desconexao. Uma track sintetica continuou
  ativa na mesma ScreenRoom durante a navegacao. Build Vite validado.

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
