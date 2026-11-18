# Visor 1.3 para Windows e web

## Transmitir uma partida

1. No Windows, abra o Visor e entre no canal **tela**. Clique em **Transmitir**, escolha **Janela** e selecione o jogo. Use **Tela** para incluir tudo o que aparece no monitor.
2. Em **Motor de captura**, confira **Rust**. Escolha **1080** e **60**. O motor seleciona o quadro mais recente a cada intervalo da transmissão, inclusive quando o jogo roda acima de 60 FPS.
3. Escolha o áudio. Em **Tudo**, marque os aplicativos que deseja excluir. Clique em **Iniciar**. Se o Windows pedir permissão para captura sem borda, autorize. O seletor também oferece Chromium.
4. No site, entre no mesmo canal, clique em **Transmitir**, configure a qualidade e confirme a fonte no seletor do navegador. Para compartilhar áudio, habilite essa opção no seletor quando disponível.

## Ajustar a qualidade

O padrão para uma nova configuração de 1080p60 é 25 Mbps. O Visor preserva o valor salvo. No painel, o medidor estima o upload antes da partida. **Usar limite medido** leva o slider até o degrau recomendado, com teto de 50 Mbps por espectador. Também dá para ajustar durante a transmissão.

O valor do slider é o teto de vídeo de cada conexão. Uma cena parada consome menos. O envio de uma cena em movimento depende do encoder, do upload disponível e da conexão de quem assiste. Com dois espectadores recebendo 25 Mbps cada, reserve mais de 50 Mbps de upload para incluir áudio e tráfego de rede.

Para investigar uma queda, abra **Diagnóstico** nas duas pontas durante a mesma cena. Compare **fps WGC**, **fps texturas**, **fps envio** e **fps decod.**. Veja também **fila RTP**, **buffer**, **perda** e **travou**. Anote a resolução e a quantidade de espectadores.

## Entrar na chamada e assistir

Ao entrar no canal de tela, sua foto aparece abaixo do canal. O ponto branco identifica quem transmite. Passe o mouse sobre a pessoa para ver a prévia silenciosa. Clique na pessoa ou na prévia para assistir. Clique em outra pessoa ao vivo para abrir as duas telas. O volume e a tela cheia são individuais. Use o botão direito sobre a pessoa e escolha **Parar de assistir** para fechar só aquela tela.

Para colocar uma foto, clique no seu avatar no canto inferior esquerdo. Arraste JPG, PNG ou WebP, ajuste o zoom e arraste a imagem dentro do círculo. As setas do teclado também ajustam o recorte. **Salvar foto** envia a seleção em WebP de 256 × 256, com até 64 KiB.

## Publicar a próxima versão

1. Atualize a versão com `npm version X.Y.Z --no-git-tag-version`. Compile no Windows com Node, Rust MSVC e Windows SDK instalados.
2. Rode `npm run dist:win`. Confira o instalador NSIS e o portátil em `release/`. O pacote contém os helpers de captura e áudio.
3. Para repetir o teste, rode `npm run dev` e `npm run desktop:dev -- --remote-debugging-port=9333` em terminais separados. Abra a cena com `node_modules\.bin\electron.cmd scripts/fixtures/capture-1080.cjs --fast --detail --transitions`. Use um navegador de teste em perfil separado com porta local de depuração 9336 aberto no Vite.
4. Rode `node scripts/compare-capture.mjs --source "Teste de captura 1080p" --viewer-port 9336 --rounds rust,rust --mbps 50 --samples 18 --warmup 6 --require-resolution 1920x1080 --out release/qa-captura.json`. Confira FPS, resolução, travamentos e descartes. Feche os processos de teste.
5. Se houver migração, confira as pendentes com `npx supabase db push --remote --dry-run` e aplique com `npx supabase db push --remote --yes`. Envie o commit validado a `main`, confirme o deploy de produção e publique a GitHub Release com a tag no mesmo commit e os dois executáveis.
