// Ponte minima e segura entre o app web e o processo principal.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('visor', {
  desktop: true,
  platform: process.platform,
  sources: () => ipcRenderer.invoke('sources'),
  audioApps: () => ipcRenderer.invoke('audio:apps'),
  audioSupported: () => ipcRenderer.invoke('audio:supported'),
  selfPid: () => ipcRenderer.invoke('self-pid'),
  boost: (on) => ipcRenderer.invoke('boost', on),
  audioStart: (id, pid, exclude) => ipcRenderer.invoke('audio:start', id, pid, exclude),
  audioStop: (id) => ipcRenderer.invoke('audio:stop', id),
  onAudio: (cb) => {
    const h = (_e, id, chunk) => cb(id, chunk)
    ipcRenderer.on('audio:data', h)
    return () => ipcRenderer.off('audio:data', h)
  },
  onAudioEnd: (cb) => {
    const h = (_e, id, code) => cb(id, code)
    ipcRenderer.on('audio:end', h)
    return () => ipcRenderer.off('audio:end', h)
  },
})
