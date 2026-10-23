import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe2, LockKeyhole, RotateCw, Wifi, WifiOff } from 'lucide-react';

const SIGNAL_PORT = 8765;

type SignalMessage =
  | { type: 'paired' }
  | { type: 'signal'; data: RTCSessionDescriptionInit | { type: 'candidate'; candidate: RTCIceCandidateInit } };

function isPrivateIPv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return octets[0] === 10 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

function normalizeWebsiteUrl(value: string): string {
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
  const url = new URL(candidate);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS websites are supported.');
  }
  return url.toString();
}

export const RemoteBrowserApp: React.FC = () => {
  const [host, setHost] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [website, setWebsite] = useState('https://example.com');
  const [status, setStatus] = useState('Enter the Windows PC IPv4 address and its pairing code.');
  const [connected, setConnected] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const controlChannelRef = useRef<RTCDataChannel | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  useEffect(() => () => {
    controlChannelRef.current?.close();
    peerRef.current?.close();
    socketRef.current?.close();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !remoteStream) return;
    video.srcObject = remoteStream;
    void video.play().catch((error: unknown) => {
      setStatus(error instanceof Error ? `Could not play remote video: ${error.message}` : 'Could not play remote video.');
    });
    return () => {
      video.srcObject = null;
    };
  }, [remoteStream, connected]);

  const sendControl = (control: Record<string, unknown>) => {
    const channel = controlChannelRef.current;
    if (channel?.readyState === 'open') channel.send(JSON.stringify(control));
  };

  const connect = () => {
    const ipv4 = host.trim();
    if (!isPrivateIPv4(ipv4) || pairingCode.trim().length !== 6) {
      setStatus('Enter the PC’s private LAN IPv4 address and its six-digit pairing code.');
      return;
    }

    try {
      const previousPeer = peerRef.current;
      const previousSocket = socketRef.current;
      peerRef.current = null;
      socketRef.current = null;
      controlChannelRef.current = null;
      pendingCandidatesRef.current = [];
      setRemoteStream(null);
      setConnected(false);
      previousPeer?.close();
      previousSocket?.close();
      const socket = new WebSocket(`ws://${ipv4}:${SIGNAL_PORT}/signal`);
      socketRef.current = socket;
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'pair', code: pairingCode.trim() }));
        setStatus('Pairing with the Windows PC…');
      };
      socket.onerror = () => {
        if (socketRef.current === socket) {
          setStatus('Could not connect. Check the PC address, port, firewall, and Wi-Fi network.');
        }
      };
      socket.onclose = (event) => {
        if (socketRef.current !== socket) return;
        setConnected(false);
        peerRef.current?.close();
        peerRef.current = null;
        controlChannelRef.current = null;
        setRemoteStream(null);
        if (videoRef.current) videoRef.current.srcObject = null;
        if (event.code === 1008) {
          setStatus('Pairing was rejected. Check the code and try the current code shown by the PC companion.');
        } else if (event.reason) {
          setStatus(`Disconnected: ${event.reason}`);
        }
      };
      socket.onmessage = async (event) => {
        let message: SignalMessage;
        try {
          message = JSON.parse(String(event.data)) as SignalMessage;
        } catch {
          setStatus('The companion sent an invalid signaling message.');
          return;
        }
        if (message.type === 'paired') {
          setStatus('Paired. Establishing encrypted WebRTC video…');
          const peer = new RTCPeerConnection({ iceServers: [] });
          peerRef.current = peer;
          peer.addTransceiver('video', { direction: 'recvonly' });
          const channel = peer.createDataChannel('browser-control');
          controlChannelRef.current = channel;
          channel.onopen = () => {
            setStatus('Connected. Video and browser controls are encrypted.');
            try {
              sendControl({ type: 'navigate', url: normalizeWebsiteUrl(website) });
            } catch (error) {
              setStatus(error instanceof Error ? error.message : String(error));
            }
          };
          channel.onclose = () => setStatus('Browser control channel closed.');
          peer.onicecandidate = (candidateEvent) => {
            if (candidateEvent.candidate && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'signal', data: {
                type: 'candidate',
                candidate: candidateEvent.candidate.toJSON(),
              } }));
            }
          };
          peer.ontrack = (trackEvent) => {
            const stream = trackEvent.streams[0] ?? new MediaStream([trackEvent.track]);
            setRemoteStream(stream);
            setStatus('Receiving the PC browser video…');
            trackEvent.track.onunmute = () => setStatus('Receiving the PC browser video…');
          };
          peer.onconnectionstatechange = () => {
            if (peerRef.current !== peer) return;
            setConnected(peer.connectionState === 'connected');
            if (peer.connectionState === 'failed') {
              setStatus('WebRTC failed on this LAN. Check that both devices are on the same network.');
            } else if (peer.connectionState === 'disconnected') {
              setStatus('WebRTC connection interrupted.');
            }
          };
          try {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            if (peer.localDescription) {
              socket.send(JSON.stringify({ type: 'signal', data: {
                type: peer.localDescription.type,
                sdp: peer.localDescription.sdp,
              } }));
            }
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
          }
        } else if (message.type === 'signal') {
          const peer = peerRef.current;
          if (!peer) return;
          try {
            if (message.data.type === 'answer') {
              await peer.setRemoteDescription(message.data);
              for (const candidate of pendingCandidatesRef.current) await peer.addIceCandidate(candidate);
              pendingCandidatesRef.current = [];
            } else if (message.data.type === 'candidate') {
              if (peer.remoteDescription) await peer.addIceCandidate(message.data.candidate);
              else pendingCandidatesRef.current.push(message.data.candidate);
            }
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
          }
        }
      };
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const navigate = (event?: React.FormEvent) => {
    event?.preventDefault();
    try {
      const url = normalizeWebsiteUrl(website);
      setWebsite(url);
      sendControl({ type: 'navigate', url });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const sendPointer = (event: React.PointerEvent<HTMLVideoElement>, action: string) => {
    const point = getVideoPoint(event.clientX, event.clientY);
    if (!point) return;
    sendControl({
      type: 'pointer',
      action,
      button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
      buttons: event.buttons & 7,
      clickCount: Math.max(1, Math.min(2, event.detail || 1)),
      ...point,
    });
  };

  const getVideoPoint = (clientX: number, clientY: number) => {
    const video = videoRef.current;
    if (!video) return null;
    const bounds = video.getBoundingClientRect();
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (bounds.width <= 0 || bounds.height <= 0 || videoWidth <= 0 || videoHeight <= 0) return;
    const scale = Math.min(bounds.width / videoWidth, bounds.height / videoHeight);
    const displayWidth = videoWidth * scale;
    const displayHeight = videoHeight * scale;
    const offsetX = (bounds.width - displayWidth) / 2;
    const offsetY = (bounds.height - displayHeight) / 2;
    const x = (clientX - bounds.left - offsetX) / displayWidth;
    const y = (clientY - bounds.top - offsetY) / displayHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };

  const sendKey = (event: React.KeyboardEvent<HTMLVideoElement>, action: 'keyDown' | 'keyUp') => {
    event.preventDefault();
    const modifiers = (event.altKey ? 1 : 0) |
      (event.ctrlKey ? 2 : 0) |
      (event.metaKey ? 4 : 0) |
      (event.shiftKey ? 8 : 0);
    sendControl({
      type: 'key',
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      modifiers,
      text: event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey
        ? event.key
        : undefined,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#101725] text-slate-100">
      <div className="flex flex-wrap items-end gap-2 border-b border-slate-700/70 bg-[#172133] p-3">
        <label className="min-w-36 flex-1 text-[10px] uppercase tracking-wider text-slate-400">
          Windows PC IPv4
          <input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="e.g. 192.168.1.20"
            className="mt-1 block w-full rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-400"
          />
        </label>
        <label className="w-28 text-[10px] uppercase tracking-wider text-slate-400">
          Pairing code
          <input
            value={pairingCode}
            onChange={(event) => setPairingCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            maxLength={6}
            placeholder="6 digits"
            className="mt-1 block w-full rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-400"
          />
        </label>
        <button
          type="button"
          onClick={connect}
          className="rounded bg-cyan-700 px-3 py-2 text-xs font-semibold hover:bg-cyan-600"
        >
          Pair
        </button>
      </div>

      <form onSubmit={navigate} className="flex items-center gap-2 border-b border-slate-800 p-2">
        <button type="button" onClick={() => sendControl({ type: 'back' })} title="Back"
          className="rounded p-1.5 text-slate-300 hover:bg-white/10"><ArrowLeft size={15} /></button>
        <button type="button" onClick={() => sendControl({ type: 'forward' })} title="Forward"
          className="rounded p-1.5 text-slate-300 hover:bg-white/10"><ArrowRight size={15} /></button>
        <button type="button" onClick={() => sendControl({ type: 'reload' })} title="Reload"
          className="rounded p-1.5 text-slate-300 hover:bg-white/10"><RotateCw size={14} /></button>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-slate-700 bg-slate-950 px-3">
          <LockKeyhole size={12} className="shrink-0 text-emerald-400" />
          <input
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
            placeholder="https://example.com"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-white outline-none"
            aria-label="Website address"
          />
        </div>
        <button type="submit" className="rounded bg-slate-700 px-3 py-1.5 text-xs hover:bg-slate-600">Go</button>
      </form>

      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#080c12] p-2"
        onWheelCapture={(event: React.WheelEvent<HTMLDivElement>) => {
          event.preventDefault();
          event.stopPropagation();
          const point = getVideoPoint(event.clientX, event.clientY);
          if (!point) return;
          const video = videoRef.current;
          const deltaScale = event.deltaMode === 1
            ? 40
            : event.deltaMode === 2 && video
              ? video.clientHeight
              : 1;
          sendControl({
            type: 'wheel',
            ...point,
            deltaX: event.deltaX * deltaScale,
            deltaY: event.deltaY * deltaScale,
          });
        }}
      >
        {remoteStream ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            onPlaying={() => setStatus('Connected. Browser video and controls are active.')}
            onWaiting={() => setStatus('Connected. Waiting for the next browser video frame…')}
            onError={() => setStatus('The browser video could not be decoded by this device.')}
            tabIndex={0}
            onPointerDown={(event) => {
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              sendPointer(event, 'mouseDown');
            }}
            onPointerUp={(event) => sendPointer(event, 'mouseUp')}
            onPointerMove={(event) => {
              if (event.buttons) sendPointer(event, 'mouseMove');
            }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              sendKey(event, 'keyDown');
            }}
            onKeyUp={(event) => {
              sendKey(event, 'keyUp');
            }}
            className="block h-full w-full rounded object-contain outline-none focus:ring-1 focus:ring-cyan-400"
            aria-label="Remote PC browser. Click here and use the keyboard to control the remote website."
          />
        ) : (
          <div className="max-w-sm p-6 text-center">
            {connected ? <Wifi className="mx-auto text-emerald-400" /> : <WifiOff className="mx-auto text-slate-500" />}
            <Globe2 className="mx-auto mt-3 h-10 w-10 text-cyan-500" />
            <p className="mt-3 text-sm font-medium text-slate-200">PC browser stream</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Start “LAN Browser Companion” on the Windows PC, then enter one of its listed addresses and the current pairing code above.
            </p>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-slate-800 px-3 py-2 text-[10px] text-slate-400">
        <span className="truncate">{status}</span>
        <span className="shrink-0 text-cyan-300">WebRTC · LAN only</span>
      </div>
    </div>
  );
};
