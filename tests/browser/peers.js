(async () => {
  const { ScreenRoom } = await import('/src/lib/screen.js')
  const rooms = new Map()
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const actualFetch = window.fetch
  let recovered = false, calls = 0
  window.fetch = (url, options) => {
    if (url !== '/api/turn') return actualFetch(url, options)
    calls++
    return Promise.resolve(recovered
      ? Response.json({ iceServers: [{ urls: 'turn:127.0.0.1:9', username: 'qa', credential: 'qa' }], ttl: 100 })
      : new Response(null, { status: 503 }))
  }
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 180
  const ctx = canvas.getContext('2d')
  const ticker = setInterval(() => {
    ctx.fillStyle = 'hsl(' + performance.now() / 8 + ' 50% 50%)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }, 40)
  async function decoded(room) {
    const report = await room.inPc?.getStats()
    return [...(report?.values() ?? [])].find(row => row.type === 'inbound-rtp' && row.kind === 'video')?.framesDecoded ?? 0
  }
  async function playing(room) {
    for (let i = 0; i < 60; i++) {
      const frames = await decoded(room)
      if (frames > 3) return frames
      await wait(100)
    }
    throw new Error('Sem quadros de ' + room.me.id)
  }
  try {
    for (const id of ['sender', 'a', 'b']) {
      const room = new ScreenRoom({ supabase: { removeChannel() {} }, roomId: 'qa', me: { id, name:id }, onChange() {} })
      room.channel = { state: 'joined', send({ payload }) { setTimeout(() => rooms.get(payload.to)?.onSignal(payload), 0) } }
      rooms.set(id, room)
    }
    const [sender, a, b] = rooms.values()
    await sender.startShare({ stream:canvas.captureStream(25) }, '480p30', 2000000)
    for (const viewer of [a, b]) viewer.peers = [{ id:'sender', sharing:true, shareId:sender.shareId }]
    a.watch('sender')
    const before = await playing(a)
    const first = sender.out.get('a')
    const initial = first.getConfiguration().iceServers
    recovered = true
    await wait(5100)
    b.watch('sender')
    const second = await playing(b)
    const config = sender.out.get('b').getConfiguration().iceServers
    const firstPreserved = first === sender.out.get('a') && JSON.stringify(initial) === JSON.stringify(first.getConfiguration().iceServers)
    const firstAdvanced = await decoded(a) > before
    a.stopWatching('sender')
    await wait(350)
    return {
      firstAdvanced, firstPreserved, secondAdvanced: await decoded(b) > second,
      renewed: calls === 2 && config.some(server => [server.urls].flat().includes('turn:127.0.0.1:9')),
      independent: !sender.out.has('a') && sender.out.has('b'),
    }
  } finally {
    for (const room of rooms.values()) room.leave()
    clearInterval(ticker)
    window.fetch = actualFetch
  }
})()
