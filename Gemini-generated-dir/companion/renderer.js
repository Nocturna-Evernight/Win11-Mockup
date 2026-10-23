const codeElement = document.getElementById('code');
const addressElement = document.getElementById('addresses');
const statusElement = document.getElementById('status');
const indicatorElement = document.getElementById('indicator');
const canvas = document.createElement('canvas');
canvas.width = 1280;
canvas.height = 800;
const context = canvas.getContext('2d');
let peerConnection;
let frameSequence = 0;
let pendingCandidates = [];

function setStatus(state, message) {
  statusElement.textContent = message;
  indicatorElement.className = `indicator${state === 'connected' || state === 'paired' ? ' connected' : state === 'error' || state === 'failed' ? ' error' : ''}`;
}

function ensurePeerConnection() {
  if (peerConnection) return peerConnection;
  peerConnection = new RTCPeerConnection({ iceServers: [] });
  const stream = canvas.captureStream(15);
  for (const track of stream.getTracks()) {
    const sender = peerConnection.addTrack(track, stream);
    if (track.kind === 'video') {
      const parameters = sender.getParameters();
      if (parameters.encodings.length > 0) {
        parameters.encodings[0].maxBitrate = 6_000_000;
        parameters.degradationPreference = 'maintain-resolution';
        void sender.setParameters(parameters).catch((error) => {
          console.warn('Could not increase WebRTC video quality:', error);
        });
      }
    }
  }
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) window.companion.sendSignal({
      type: 'candidate',
      candidate: event.candidate.toJSON(),
    });
  };
  peerConnection.onconnectionstatechange = () => {
    window.companion.setRtcState(peerConnection.connectionState);
    setStatus(peerConnection.connectionState, `WebRTC connection: ${peerConnection.connectionState}`);
  };
  peerConnection.ondatachannel = (event) => {
    const channel = event.channel;
    channel.onmessage = (message) => {
      try {
        window.companion.sendBrowserControl(JSON.parse(message.data));
      } catch (error) {
        console.warn('Ignored invalid browser control message:', error);
      }
    };
  };
  return peerConnection;
}

window.companion.onReady(({ code, addresses, port }) => {
  codeElement.textContent = code || '------';
  addressElement.textContent = addresses.length
    ? addresses.map((address) => `ws://${address}:${port}/signal`).join('  ·  ')
    : `No private IPv4 address found. Confirm this PC is connected to Wi-Fi (port ${port}).`;
});

window.companion.onStatus(({ state, message }) => setStatus(state, message));

window.companion.onFrame(({ data, width, height }) => {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const sequence = ++frameSequence;
  void createImageBitmap(new Blob(
    [Uint8Array.from(atob(data), (character) => character.charCodeAt(0))],
    { type: 'image/jpeg' },
  )).then((bitmap) => {
    if (sequence === frameSequence) {
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    }
    bitmap.close();
  }).catch((error) => {
    console.error('Could not decode browser frame:', error);
  });
});

window.companion.onSignal(async (signal) => {
  try {
    const peer = ensurePeerConnection();
    if (signal.type === 'offer') {
      await peer.setRemoteDescription(signal);
      for (const candidate of pendingCandidates) await peer.addIceCandidate(candidate);
      pendingCandidates = [];
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      window.companion.sendSignal({
        type: peer.localDescription.type,
        sdp: peer.localDescription.sdp,
      });
    } else if (signal.type === 'candidate' && signal.candidate) {
      if (peer.remoteDescription) await peer.addIceCandidate(signal.candidate);
      else pendingCandidates.push(signal.candidate);
    }
  } catch (error) {
    console.error('WebRTC negotiation failed:', error);
    setStatus('error', `WebRTC negotiation failed: ${error.message}`);
  }
});
