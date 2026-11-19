// Ponte minima e segura entre o app web e o processo principal.
const { contextBridge, ipcRenderer, sharedTexture } = require('electron')

const canReceiveTexture = typeof sharedTexture?.setSharedTextureReceiver === 'function'
if (canReceiveTexture) {
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, id) => {
    let frame
    try {
      frame = importedSharedTexture.getVideoFrame()
      window.postMessage({ type: 'visor:capture:frame', id, frame }, '*', [frame])
    } catch (error) {
      console.warn('[visor-capture]', error)
    } finally {
      frame?.close()
      importedSharedTexture.release()
    }
  })
}

function subscribe(channel, callback) {
  const listener = (_event, ...args) => callback(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

contextBridge.exposeInMainWorld('visor', {
  desktop: true,
  checkUpdate: auth => ipcRenderer.invoke('update:check', auth),
  installUpdate: auth => ipcRenderer.invoke('update:install', auth),
  onUpdateProgress: callback => subscribe('update:progress',callback),
  platform: process.platform,
  sources: () => ipcRenderer.invoke('sources'),
  audioApps: () => ipcRenderer.invoke('audio:apps'),
  audioSupported: () => ipcRenderer.invoke('audio:supported'),
  selfPid: () => ipcRenderer.invoke('self-pid'),
  boost: (on) => ipcRenderer.invoke('boost', on),
  captureAvailable: () => canReceiveTexture ? ipcRenderer.invoke('capture:available') : Promise.resolve(false),
  captureStart: (id, source, preset) => ipcRenderer.invoke('capture:start', id, source, preset),
  capturePreset: (id, preset) => ipcRenderer.invoke('capture:preset', id, preset),
  captureStop: (id) => ipcRenderer.invoke('capture:stop', id),
  onCaptureEnd: (callback) => subscribe('capture:ended', callback),
  onCaptureStats: (callback) => subscribe('capture:stats', callback),
  audioStart: (id, pid, exclude) => ipcRenderer.invoke('audio:start', id, pid, exclude),
  audioStop: (id) => ipcRenderer.invoke('audio:stop', id),
  onAudio: (callback) => subscribe('audio:data', callback),
  onAudioEnd: (callback) => subscribe('audio:end', callback),
})
