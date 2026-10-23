const { app, BrowserWindow, clipboard, ipcMain, Menu, Tray } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { createServer } = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');

const SIGNAL_PORT = 8765;
const SIGNAL_PATH = '/signal';
const MAX_SIGNAL_BYTES = 128 * 1024;
const MAX_PENDING_PAIRINGS = 8;
const PAIRING_TIMEOUT_MS = 10_000;
const FRAME_RATE = 15;
const MAX_FRAME_WIDTH = 1920;

let companionWindow;
let browserWindow;
let tray;
let httpServer;
let webSocketServer;
let browserSocket;
let pairingCode = createPairingCode();
let pairingExpiresAt = Date.now() + 5 * 60 * 1000;
let pairingExpiryTimer;
const pairingAttempts = new Map();
const pendingPairSockets = new Set();
let isFrameStreaming = false;
let isQuitting = false;
let inputCommandQueue = Promise.resolve();
let currentStatus = { state: 'waiting', message: 'Starting local-only signaling service…' };

function createPairingCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function isPrivateIPv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

function getLanAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const network of interfaces || []) {
      if (network.family === 'IPv4' && !network.internal && isPrivateIPv4(network.address)) {
        addresses.push(network.address);
      }
    }
  }
  return [...new Set(addresses)];
}

function publishStatus(state, message) {
  currentStatus = { state, message };
  updateTrayMenu();
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.webContents.send('companion-status', currentStatus);
  }
}

function showCompanionWindow() {
  if (!companionWindow || companionWindow.isDestroyed()) return;
  companionWindow.show();
  companionWindow.focus();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setToolTip(`LAN Browser Bridge — ${currentStatus.message}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Pairing code: ' + (pairingCode || 'already paired'), enabled: false },
    { label: 'Copy pairing details', enabled: Boolean(pairingCode), click: copyPairingDetails },
    { type: 'separator' },
    { label: 'Show status panel', click: showCompanionWindow },
    { label: currentStatus.message, enabled: false },
    { type: 'separator' },
    { label: 'Quit Browser Bridge', click: () => app.quit() },
  ]));
}

function copyPairingDetails() {
  if (!pairingCode) return;
  const addresses = getLanAddresses();
  clipboard.writeText([
    `Pairing code: ${pairingCode}`,
    ...addresses.map((address) => `ws://${address}:${SIGNAL_PORT}${SIGNAL_PATH}`),
  ].join('\n'));
}

function schedulePairingExpiry() {
  clearTimeout(pairingExpiryTimer);
  pairingExpiryTimer = setTimeout(() => {
    if (!browserSocket && pairingCode && Date.now() >= pairingExpiresAt) {
      pairingCode = createPairingCode();
      pairingExpiresAt = Date.now() + 5 * 60 * 1000;
      publishStatus('waiting', 'The pairing code expired and has been refreshed.');
      publishPairingInfo();
    }
    if (!browserSocket) schedulePairingExpiry();
  }, Math.max(1000, pairingExpiresAt - Date.now()));
}

async function createTray() {
  const icon = await app.getFileIcon(process.execPath, { size: 'small' });
  if (icon.isEmpty()) throw new Error('Windows did not provide an application icon for the notification area.');
  tray = new Tray(icon);
  tray.on('click', showCompanionWindow);
  updateTrayMenu();
}

function publishPairingInfo() {
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.webContents.send('companion-ready', {
      port: SIGNAL_PORT,
      code: pairingCode,
      addresses: getLanAddresses(),
    });
    companionWindow.webContents.send('companion-status', currentStatus);
  }
}

function createBrowserWindow() {
  if (browserWindow && !browserWindow.isDestroyed()) {
    return browserWindow;
  }
  browserWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'ESP32 Remote Browser',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  browserWindow.webContents.setFrameRate(FRAME_RATE);
  browserWindow.webContents.debugger.attach('1.3');
  browserWindow.webContents.on('paint', (_event, _dirtyRect, image) => {
    if (!isFrameStreaming || !browserSocket || browserSocket.readyState !== WebSocket.OPEN ||
        !companionWindow || companionWindow.isDestroyed()) return;
    try {
      const imageSize = image.getSize();
      const frame = imageSize.width > MAX_FRAME_WIDTH
        ? image.resize({
          width: MAX_FRAME_WIDTH,
          height: Math.round(imageSize.height * MAX_FRAME_WIDTH / imageSize.width),
        })
        : image;
      const frameSize = frame.getSize();
      companionWindow.webContents.send('browser-frame', {
        data: frame.toJPEG(84).toString('base64'),
        width: frameSize.width,
        height: frameSize.height,
      });
    } catch (error) {
      console.error('Offscreen browser frame processing failed:', error);
    }
  });
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedBrowserUrl(url)) {
      void browserWindow.webContents.loadURL(url).catch((error) => {
        if (error.code !== 'ERR_ABORTED' && error.errno !== -3) {
          publishStatus('error', `Could not open website: ${error.message}`);
        }
      });
    }
    return { action: 'deny' };
  });
  browserWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedBrowserUrl(url)) event.preventDefault();
  });
  browserWindow.on('closed', () => {
    browserWindow = undefined;
    inputCommandQueue = Promise.resolve();
    if (browserSocket) browserSocket.close(1001, 'Browser window closed');
  });
  return browserWindow;
}

function isAllowedBrowserUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sendBrowserControl(control) {
  if (!browserWindow || browserWindow.isDestroyed() ||
      !control || typeof control !== 'object' || typeof control.type !== 'string') {
    return;
  }
  const contents = browserWindow.webContents;
  const size = browserWindow.getContentSize();
  const dispatchInput = (method, params) => {
    inputCommandQueue = inputCommandQueue.then(async () => {
      if (!browserWindow || browserWindow.isDestroyed() || contents.isDestroyed()) return;
      await contents.debugger.sendCommand(method, params);
    }).catch((error) => {
      publishStatus('error', `Could not send remote input: ${error.message}`);
    });
  };
  switch (control.type) {
    case 'navigate':
      if (typeof control.url === 'string' && isAllowedBrowserUrl(control.url)) {
        void contents.loadURL(control.url).catch((error) => {
          if (error.code === 'ERR_ABORTED' || error.errno === -3) return;
          publishStatus('error', `Could not open website: ${error.message}`);
        });
      }
      break;
    case 'reload':
      contents.reload();
      break;
    case 'back':
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      break;
    case 'forward':
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      break;
    case 'pointer':
      if (!['mouseDown', 'mouseUp', 'mouseMove'].includes(control.action) ||
          !['left', 'middle', 'right'].includes(control.button) ||
          !Number.isFinite(control.x) || !Number.isFinite(control.y) ||
          control.x < 0 || control.x > 1 || control.y < 0 || control.y > 1) return;
      void dispatchInput('Input.dispatchMouseEvent', {
        type: control.action === 'mouseDown'
          ? 'mousePressed'
          : control.action === 'mouseUp'
            ? 'mouseReleased'
            : 'mouseMoved',
        x: Math.round(control.x * size[0]),
        y: Math.round(control.y * size[1]),
        button: control.action === 'mouseMove' ? 'none' : control.button,
        buttons: control.buttons,
        clickCount: control.clickCount,
        pointerType: 'mouse',
      });
      break;
    case 'wheel':
      if (!Number.isFinite(control.x) || !Number.isFinite(control.y) ||
          control.x < 0 || control.x > 1 || control.y < 0 || control.y > 1 ||
          !Number.isFinite(control.deltaX) || !Number.isFinite(control.deltaY)) return;
      void dispatchInput('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round((control.x || 0) * size[0]),
        y: Math.round((control.y || 0) * size[1]),
        deltaX: Math.max(-1200, Math.min(1200, control.deltaX)),
        deltaY: Math.max(-1200, Math.min(1200, control.deltaY)),
        pointerType: 'mouse',
      });
      break;
    case 'key':
      if ((control.action !== 'keyDown' && control.action !== 'keyUp') ||
          typeof control.key !== 'string' || control.key.length === 0 || control.key.length > 32 ||
          typeof control.code !== 'string' || control.code.length > 32 ||
          !Number.isInteger(control.modifiers) || control.modifiers < 0 || control.modifiers > 15) return;
      void dispatchInput('Input.dispatchKeyEvent', {
        type: control.action,
        key: control.key,
        code: control.code,
        modifiers: control.modifiers,
        windowsVirtualKeyCode: control.keyCode,
        nativeVirtualKeyCode: control.keyCode,
        ...(control.action === 'keyDown' && typeof control.text === 'string' && control.text.length <= 8
          ? { text: control.text, unmodifiedText: control.text }
          : {}),
      });
      break;
    default:
      break;
  }
}

function isAllowedOrigin(origin) {
  if (typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' ||
       isPrivateIPv4(url.hostname));
  } catch {
    return false;
  }
}

function resetPairing() {
  stopFrameCapture();
  browserSocket = undefined;
  pairingCode = createPairingCode();
  pairingExpiresAt = Date.now() + 5 * 60 * 1000;
  schedulePairingExpiry();
  publishStatus('waiting', 'Disconnected. A new pairing code is ready.');
  publishPairingInfo();
}

function startSignalServer() {
  httpServer = createServer((request, response) => {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_SIGNAL_BYTES,
    perMessageDeflate: false,
  });
  httpServer.on('upgrade', (request, socket, head) => {
    let requestPath;
    try {
      requestPath = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (requestPath !== SIGNAL_PATH || !isAllowedOrigin(request.headers.origin)) {
      socket.destroy();
      return;
    }
    const sourceAddress = request.socket.remoteAddress || 'unknown';
    const attemptState = pairingAttempts.get(sourceAddress);
    if (attemptState && Date.now() - attemptState.startedAt > 60_000) {
      pairingAttempts.delete(sourceAddress);
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.sourceAddress = sourceAddress;
      webSocketServer.emit('connection', webSocket);
    });
  });
  webSocketServer.on('connection', (socket) => {
    if (browserSocket || pendingPairSockets.size >= MAX_PENDING_PAIRINGS) {
      socket.close(1008, 'Companion is busy');
      return;
    }
    let authenticated = false;
    pendingPairSockets.add(socket);
    const pairingTimeout = setTimeout(() => socket.close(1008, 'Pairing timed out'), PAIRING_TIMEOUT_MS);
    socket.on('message', (message) => {
      let request;
      try {
        request = JSON.parse(message.toString());
      } catch {
        socket.close(1003, 'Invalid message');
        return;
      }
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        socket.close(1003, 'Invalid message');
        return;
      }
      if (!authenticated) {
        const address = socket.sourceAddress;
        let attempts = pairingAttempts.get(address);
        if (!attempts || Date.now() - attempts.startedAt > 60_000) {
          attempts = { startedAt: Date.now(), count: 0 };
          pairingAttempts.set(address, attempts);
        }
        attempts.count += 1;
        if (attempts.count > 5) {
          socket.close(1008, 'Pairing rate limit exceeded');
          return;
        }
        if (!browserSocket && Date.now() >= pairingExpiresAt) {
          pairingCode = createPairingCode();
          pairingExpiresAt = Date.now() + 5 * 60 * 1000;
          schedulePairingExpiry();
          publishStatus('waiting', 'The previous pairing code expired. Use the refreshed code.');
          publishPairingInfo();
        }
        if (request.type !== 'pair' || request.code !== pairingCode || browserSocket) {
          socket.close(1008, 'Invalid or already-used pairing code');
          return;
        }
        pairingAttempts.delete(address);
        authenticated = true;
        clearTimeout(pairingTimeout);
        pendingPairSockets.delete(socket);
        browserSocket = socket;
        pairingCode = '';
        clearTimeout(pairingExpiryTimer);
        socket.send(JSON.stringify({ type: 'paired' }));
        publishPairingInfo();
        publishStatus('paired', 'A browser viewer is connected. The session is encrypted with WebRTC.');
        createBrowserWindow();
        return;
      }
      if (request.type !== 'signal') return;
      if (browserSocket !== socket || !request.data ||
          typeof request.data !== 'object' ||
          !['offer', 'candidate'].includes(request.data.type) ||
          (request.data.type === 'offer' &&
           (typeof request.data.sdp !== 'string' || request.data.sdp.length > 64 * 1024)) ||
          (request.data.type === 'candidate' &&
           (!request.data.candidate || typeof request.data.candidate !== 'object' ||
            typeof request.data.candidate.candidate !== 'string' ||
            request.data.candidate.candidate.length > 4096))) {
        return;
      }
      if (companionWindow && !companionWindow.isDestroyed()) {
        companionWindow.webContents.send('webrtc-signal', request.data);
      }
    });
    socket.on('close', () => {
      clearTimeout(pairingTimeout);
      pendingPairSockets.delete(socket);
      if (browserSocket === socket) resetPairing();
    });
    socket.on('error', (error) => {
      console.error('Browser signaling socket error:', error.message);
    });
  });
  httpServer.on('error', (error) => {
    console.error(`LAN companion could not bind port ${SIGNAL_PORT}:`, error);
    publishStatus('error', `Could not open LAN port ${SIGNAL_PORT}: ${error.message}`);
  });
  httpServer.listen(SIGNAL_PORT, '0.0.0.0', () => {
    publishStatus('waiting', `Ready on port ${SIGNAL_PORT}. Share the code only with a trusted device on your LAN.`);
  });
}

function sendSignalToBrowser(signal) {
  if (browserSocket && browserSocket.readyState === WebSocket.OPEN) {
    browserSocket.send(JSON.stringify({ type: 'signal', data: signal }));
  }
}

function startFrameCapture() {
  isFrameStreaming = true;
}

function stopFrameCapture() {
  isFrameStreaming = false;
}

function createCompanionWindow() {
  companionWindow = new BrowserWindow({
    width: 560,
    height: 520,
    show: false,
    resizable: false,
    title: 'ESP32 LAN Browser Companion',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  companionWindow.removeMenu();
  companionWindow.loadFile(path.join(__dirname, 'index.html'));
  companionWindow.webContents.on('did-finish-load', () => {
    publishPairingInfo();
  });
  companionWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    companionWindow.hide();
  });
}

ipcMain.on('companion-signal', (event, signal) => {
  if (!companionWindow || event.sender !== companionWindow.webContents ||
      !signal || !['answer', 'candidate'].includes(signal.type)) return;
  sendSignalToBrowser(signal);
});

ipcMain.on('browser-control', (event, control) => {
  if (companionWindow && event.sender === companionWindow.webContents) sendBrowserControl(control);
});

ipcMain.on('companion-rtc-state', (event, state) => {
  if (!companionWindow || event.sender !== companionWindow.webContents) return;
  if (state === 'connected') {
    publishStatus('paired', 'Browser connected. WebRTC video and control are encrypted.');
    startFrameCapture();
  } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
    stopFrameCapture();
    publishStatus(state, `WebRTC state: ${state}`);
  }
});

if (app.requestSingleInstanceLock()) {
  app.whenReady().then(async () => {
    await createTray();
    createCompanionWindow();
    schedulePairingExpiry();
    startSignalServer();
  }).catch((error) => {
    console.error('Could not start LAN Browser Bridge:', error);
    app.quit();
  });
} else {
  app.quit();
}

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopFrameCapture();
  clearTimeout(pairingExpiryTimer);
  if (browserSocket) browserSocket.close(1001, 'Companion stopping');
  if (webSocketServer) webSocketServer.close();
  if (httpServer) httpServer.close();
});

app.on('will-quit', () => {
  if (tray) tray.destroy();
});
