// Keep changes received while a SELECT is in flight, including local writes confirmed by the API.
export function createLiveRows(read, publish, initial = null) {
  let rows = initial, changes = null, generation = 0, closed = false, retry
  function change(apply) {
    if (closed) return
    changes?.push(apply)
    if (rows !== null) publish(rows = apply(rows))
  }
  async function load() {
    if (closed) return
    clearTimeout(retry)
    const request = ++generation
    changes = []
    try {
      const { data, error } = await read()
      if (closed || request !== generation) return
      if (error) throw error
      rows = changes.reduce((list, apply) => apply(list), data)
      changes = null
      publish(rows)
    } catch {
      if (!closed && request === generation) {
        changes = null
        retry = setTimeout(load, 5000)
      }
    }
  }
  return {
    change, load,
    onStatus(status) { if (status === 'SUBSCRIBED') load() },
    close() { closed = true; changes = null; clearTimeout(retry) },
  }
}

export function applyRowEvent(rows, { eventType, new: row, old }) {
  if (eventType === 'DELETE') return rows.filter(item => item.id !== old.id)
  const index = rows.findIndex(item => item.id === row.id)
  if (index < 0) return [...rows, row]
  return rows.map((item, i) => i === index ? row : item)
}
