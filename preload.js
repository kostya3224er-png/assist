const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('assist', {
  load: () => ipcRenderer.invoke('data:load'),
  save: data => ipcRenderer.invoke('data:save', data),
  secretStorageStatus: () => ipcRenderer.invoke('app:secret-storage-status'),
  reset: () => ipcRenderer.invoke('data:reset'),
  toggle: () => ipcRenderer.invoke('app:toggle'),
  close: () => ipcRenderer.invoke('app:close'),
  onCursorVisibility: callback => ipcRenderer.on('app:cursor-visibility', (_event, hidden) => callback(!!hidden)),
  minimize: () => ipcRenderer.invoke('app:minimize'),
  setSize: (width, height) => ipcRenderer.invoke('app:size', { width, height }),
  setOpacity: value => ipcRenderer.invoke('app:opacity', value),
  setStreamProof: enabled => ipcRenderer.invoke('app:stream-proof', enabled),
  copy: text => ipcRenderer.invoke('app:copy', text),
  setHotkeys: (overlay, cursor) => ipcRenderer.invoke('app:hotkeys', { overlay, cursor }),
  setHotkeyCapture: enabled => ipcRenderer.invoke('app:hotkey-capture', !!enabled),
  setTextInputActive: active => ipcRenderer.invoke('app:text-focus', !!active),
  activateTextInput: () => ipcRenderer.sendSync('app:activate-text-input'),
  onHotkeyCaptured: callback => ipcRenderer.on('app:hotkey-captured', (_event, value) => callback(value)),
  audioOutputs: () => ipcRenderer.invoke('audio:outputs'),
  startSystemAudio: () => ipcRenderer.invoke('audio:system-start'),
  stopSystemAudio: () => ipcRenderer.invoke('audio:system-stop'),
  onSystemAudioData: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('audio:system-data', listener);
    return () => ipcRenderer.removeListener('audio:system-data', listener);
  },
  setAudioOutput: id => ipcRenderer.invoke('audio:set-output', id),
  chat: data => ipcRenderer.invoke('ai:chat', data),
  onChatDelta: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('ai:delta', listener);
    return () => ipcRenderer.removeListener('ai:delta', listener);
  },
  cancelChat: id => ipcRenderer.send('ai:cancel', id),
  transcribe: data => ipcRenderer.invoke('ai:transcribe', data),
  chooseGoogleCredentials: () => ipcRenderer.invoke('google-speech:choose-credentials'),
  search: data => ipcRenderer.invoke('web:search', data)
});
