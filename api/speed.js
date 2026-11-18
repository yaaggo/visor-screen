// Vercel Function: recebe um corpo binario e devolve quantos bytes chegaram (teste de upload).
export async function POST(request) {
  let bytes = 0
  const reader = request.body?.getReader()
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
    }
  }
  return Response.json({ bytes }, { headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } })
}
