const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('companion', {
  onReady: (callback) => subscribe('companion-ready', callback),
  onStatus: (callback) => subscribe('companion-status', callback),
  onFrame: (callback) => subscribe('browser-frame', callback),
  onSignal: (callback) => subscribe('webrtc-signal', callback),
  sendSignal: (signal) => ipcRenderer.send('companion-signal', signal),
  sendBrowserControl: (control) => ipcRenderer.send('browser-control', control),
  setRtcState: (state) => ipcRenderer.send('companion-rtc-state', state),
});
