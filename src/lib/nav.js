// Transicao entre paginas sem roteador: quem sai anota de onde veio, quem entra le e escolhe a animacao.
// from: 'clips' (voltando da pagina de clipes para o deck) ou null.
export const nav = { from: null }

// Le e limpa (a animacao de chegada so roda uma vez).
export function arrivedFrom(page) {
  const hit = nav.from === page
  if (hit) nav.from = null
  return hit
}
