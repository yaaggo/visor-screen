const { createHash } = require('node:crypto')
const { mkdtemp, open, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const base = 'https://gyqnzjjvugrfpbnfjbrf.supabase.co/storage/v1/object/authenticated/desktop-updates/'
const stable = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
const chunkSize = 24 * 1024 * 1024

async function read(name, auth) {
  const resp = await fetch(base + name, { redirect:'error', cache:'no-store', signal:AbortSignal.timeout(180000),
    headers:{ apikey:auth.key, Authorization:'Bearer ' + auth.token } })
  if (!resp.ok) throw Error('Atualização indisponível')
  return resp
}
async function latest(current, auth) {
  const info = await (await read('latest.json',auth)).json()
  if (!stable.test(info.version) || !stable.test(current) || !/^[a-f0-9]{64}$/.test(info.sha256) ||
      !Number.isSafeInteger(info.size) || info.size<=0 || info.size>512*1024*1024) throw Error('Pacote inválido')
  const old = current.split('.').map(Number)
  const diff = info.version.split('.').map((v,i)=>Number(v)-old[i]).find(n=>n!==0)
  return diff>0 ? info : null
}
async function download(info, auth, progress) {
  const folder = await mkdtemp(path.join(tmpdir(),'visor-update-'))
  const installer = path.join(folder,'Visor-Setup-'+info.version+'.exe')
  try {
    const file = await open(installer,'wx')
    const hash = createHash('sha256')
    let bytes = 0
    try {
      for (let i=0;bytes<info.size;i++) {
        const part = await read(info.version+'/'+i+'.bin',auth)
        const expected = Math.min(chunkSize,info.size-bytes)
        let length = 0
        for await (const data of part.body) {
          length += data.length
          if (length>expected) throw Error('Parte inválida')
          hash.update(data)
          await file.writeFile(data)
        }
        if (length!==expected) throw Error('Download incompleto')
        bytes += length
        progress(Math.round(bytes/info.size*100))
      }
    } finally { await file.close() }
    if (hash.digest('hex')!==info.sha256) throw Error('Falha na verificação da atualização')
    return installer
  } catch (error) {
    await rm(folder,{recursive:true,force:true})
    throw error
  }
}
function registerUpdates(app, ipcMain, getWindow) {
  // ready: instalador baixado e verificado; job: download em segundo plano em andamento
  let ready = null, job = null, installing = false
  function trusted(event) {
    const contents = getWindow()?.webContents
    return app.isPackaged && process.platform==='win32' && contents===event.sender &&
      event.senderFrame===contents.mainFrame && contents.getURL().startsWith('file:')
  }
  function prepare(info, auth) {
    if (ready?.version===info.version) return Promise.resolve(ready)
    if (job?.version===info.version) return job.promise
    const promise = download(info,auth,n=>getWindow()?.webContents.send('update:progress',n))
      .then(file => {
        if (ready) rm(path.dirname(ready.file),{recursive:true,force:true}).catch(()=>{})
        ready = {version:info.version,file}
        getWindow()?.webContents.send('update:ready',info.version)
        return ready
      })
      .finally(() => { if (job?.promise===promise) job = null })
    job = {version:info.version,promise}
    return promise
  }
  ipcMain.handle('update:check',async (event,auth) => {
    if (!trusted(event)) return null
    const info = await latest(app.getVersion(),auth)
    if (!info) return null
    if (ready?.version===info.version) return {version:info.version,ready:true}
    prepare(info,auth).catch(()=>{})
    return {version:info.version,ready:false}
  })
  ipcMain.handle('update:install',async (event,auth) => {
    if (!trusted(event) || installing) return false
    installing = true
    try {
      let target = ready
      if (!target) {
        const info = await latest(app.getVersion(),auth)
        if (!info) return false
        target = await prepare(info,auth)
      }
      // --force-run reabre o Visor assim que o instalador silencioso termina
      const child = spawn(target.file,['/S','--force-run'],{detached:true,stdio:'ignore',windowsHide:true})
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})
      child.unref()
      setImmediate(()=>app.quit())
      return true
    } finally { installing = false }
  })
}
module.exports = {registerUpdates,latest,download}
