// As taxas usam o intervalo real entre amostras e o mesmo ID de RTP.
function delta(stat, previous, key) {
  if (previous?.[key] == null || stat[key] == null) return null
  const value = stat[key] - previous[key]
  return value >= 0 ? value : null
}

function rate(stat, previous, key, factor) {
  const elapsed = stat.timestamp - previous?.timestamp
  const change = delta(stat, previous, key)
  return elapsed > 0 && change != null ? Math.round((change * factor) / elapsed) : null
}

function averageMs(stat, previous, timeKey, countKey) {
  const count = delta(stat, previous, countKey)
  const time = delta(stat, previous, timeKey)
  return count > 0 && time != null ? Math.round((time * 10_000) / count) / 10 : null
}

function videoRtp(report, type) {
  if (!report) return null
  for (const stat of report.values()) {
    if (stat.type !== type || (stat.kind ?? stat.mediaType) !== 'video') continue
    const codec = report.get(stat.codecId)?.mimeType.split('/')[1]
    if (!/^(rtx|red|ulpfec|flexfec)/i.test(codec ?? '')) return { stat, codec }
  }
  return null
}

function connection(report, stat) {
  const transport = report.get(stat.transportId)
  const pair = report.get(transport?.selectedCandidatePairId)
    ?? [...report.values()].find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded')
  const local = report.get(pair?.localCandidateId)?.candidateType
  const remote = report.get(pair?.remoteCandidateId)?.candidateType
  let route = null
  if (local === 'relay' || remote === 'relay') route = 'relay'
  else if (local && remote) route = local === 'host' && remote === 'host' ? 'host' : 'direta'
  return { pair, route }
}

const millis = (seconds) => seconds == null ? null : Math.round(seconds * 1000)

export function readOutboundVideo(report, previous) {
  const video = videoRtp(report, 'outbound-rtp')
  if (!video) return null
  const { stat, codec } = video
  const prior = previous?.get(stat.id)
  const source = report.get(stat.mediaSourceId)
  const remote = report.get(stat.remoteId)
  const { pair, route } = connection(report, stat)
  return {
    capture: source ? rate(source, previous?.get(source.id), 'frames', 1000) ?? source.framesPerSecond ?? null : null,
    encoded: rate(stat, prior, 'framesEncoded', 1000) ?? stat.framesPerSecond ?? null,
    fps: rate(stat, prior, 'framesSent', 1000),
    kbps: rate(stat, prior, 'bytesSent', 8),
    height: stat.frameHeight,
    encodeMs: averageMs(stat, prior, 'totalEncodeTime', 'framesEncoded'),
    sendQueueMs: averageMs(stat, prior, 'totalPacketSendDelay', 'packetsSent'),
    encoder: stat.encoderImplementation,
    powerEfficient: stat.powerEfficientEncoder,
    limit: stat.qualityLimitationReason,
    uplink: pair?.availableOutgoingBitrate,
    rtt: millis(remote?.roundTripTime ?? pair?.currentRoundTripTime),
    loss: remote?.fractionLost == null ? null : Math.round(remote.fractionLost * 1000) / 10,
    route,
    codec,
  }
}

export function readInboundVideo(report, previous) {
  const video = videoRtp(report, 'inbound-rtp')
  if (!video) return null
  const { stat, codec } = video
  const prior = previous?.get(stat.id)
  const { pair, route } = connection(report, stat)
  const received = delta(stat, prior, 'packetsReceived')
  // O contador de perda pode cair quando chegam pacotes atrasados.
  const lost = prior?.packetsLost == null || stat.packetsLost == null
    ? null : Math.max(0, stat.packetsLost - prior.packetsLost)
  const packets = received != null && lost != null ? received + lost : 0
  return {
    width: stat.frameWidth,
    height: stat.frameHeight,
    fps: rate(stat, prior, 'framesReceived', 1000),
    decoded: rate(stat, prior, 'framesDecoded', 1000) ?? stat.framesPerSecond ?? null,
    kbps: rate(stat, prior, 'bytesReceived', 8),
    dropped: delta(stat, prior, 'framesDropped'),
    freezes: stat.freezeCount,
    decodeMs: averageMs(stat, prior, 'totalDecodeTime', 'framesDecoded'),
    bufferMs: averageMs(stat, prior, 'jitterBufferDelay', 'jitterBufferEmittedCount'),
    decoder: stat.decoderImplementation,
    powerEfficient: stat.powerEfficientDecoder,
    jitter: millis(stat.jitter),
    rtt: millis(pair?.currentRoundTripTime),
    loss: packets > 0 ? Math.round((lost * 1000) / packets) / 10 : null,
    route,
    codec,
  }
}
