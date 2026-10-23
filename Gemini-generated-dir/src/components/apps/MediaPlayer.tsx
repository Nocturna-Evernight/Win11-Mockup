import React, { useEffect, useRef, useState } from 'react';
import { Disc3, FileAudio, FileVideo, HardDrive, ListMusic, Music2, Pause, Play, SkipBack, SkipForward, Subtitles, Volume2, VolumeX } from 'lucide-react';

interface MediaTrack {
  name: string;
  size: number;
  url: string;
  kind: 'audio' | 'video';
  source: 'local' | 'usb';
}

interface SubtitleTrack {
  name: string;
  url: string;
}

interface UsbMediaEntry {
  name: string;
  path: string;
  sourcePath?: string;
  isFolder: boolean;
  size: number;
}

type MediaFileLike = Pick<File, 'name' | 'type'>;

const MEDIA_EXTENSIONS = new Set([
  '3gp', 'aac', 'aif', 'aiff', 'avi', 'flac', 'm2ts', 'm4a', 'm4v', 'mka',
  'mkv', 'mov', 'mp3', 'mp4', 'mpeg', 'mpg', 'oga', 'ogg', 'ogv', 'opus',
  'ts', 'wav', 'webm', 'weba', 'wma', 'wmv',
]);

const encodeHeaderValue = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const getMediaKind = (file: MediaFileLike): MediaTrack['kind'] | null => {
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/')) return 'video';

  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!extension || !MEDIA_EXTENSIONS.has(extension)) return null;
  return ['3gp', 'avi', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'ts', 'webm', 'wmv'].includes(extension)
    ? 'video'
    : 'audio';
};

const toWebVtt = (contents: string, fileName: string): string => {
  const normalized = contents.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT(?:\s|$)/.test(normalized)) {
    return `${normalized}\n`;
  }

  if (!/^\s*(?:\d+\s*\n)?\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(normalized)) {
    throw new Error(`${fileName} is not a valid SRT or WebVTT subtitle file.`);
  }

  const cues = normalized
    .replace(/^\d+\s*\n(?=\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->)/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${cues}\n`;
};

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

export const MediaPlayerApp: React.FC = () => {
  const [tracks, setTracks] = useState<MediaTrack[]>([]);
  const [trackIndex, setTrackIndex] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const [subtitles, setSubtitles] = useState<SubtitleTrack[]>([]);
  const [usbBrowserOpen, setUsbBrowserOpen] = useState(false);
  const [usbBrowserPath, setUsbBrowserPath] = useState('/media');
  const [usbEntries, setUsbEntries] = useState<UsbMediaEntry[]>([]);
  const [isLoadingUsb, setIsLoadingUsb] = useState(false);
  const currentTrack = tracks[trackIndex];
  const isVideo = currentTrack?.kind === 'video';

  useEffect(() => {
    return () => {
      tracks.forEach((track) => URL.revokeObjectURL(track.url));
    };
  }, [tracks]);

  useEffect(() => {
    return () => {
      subtitles.forEach((subtitle) => URL.revokeObjectURL(subtitle.url));
    };
  }, [subtitles]);

  const openFiles = (files: FileList | null) => {
    if (!files?.length) {
      return;
    }

    const selected = Array.from(files)
      .map((file) => ({ file, kind: getMediaKind(file) }))
      .filter((item): item is { file: File; kind: MediaTrack['kind'] } => item.kind !== null);
    if (selected.length === 0) {
      setErrorMessage('No supported audio or video files were selected.');
      return;
    }

    setTracks((previous) => {
      previous.forEach((track) => URL.revokeObjectURL(track.url));
      return selected.map(({ file, kind }) => ({
        name: file.name,
        size: file.size,
        kind,
        source: 'local' as const,
        url: URL.createObjectURL(file),
      }));
    });
    setSubtitles([]);
    setTrackIndex(0);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setErrorMessage(null);
  };

  const openSubtitles = async (files: FileList | null) => {
    if (!files?.length) return;

    const selected = Array.from(files);
    if (selected.some((file) => !/\.(srt|vtt)$/i.test(file.name))) {
      setErrorMessage('Subtitle files must use the .srt or .vtt extension.');
      return;
    }
    try {
      const subtitleTracks = await Promise.all(selected.map(async (file) => {
        const vtt = toWebVtt(await file.text(), file.name);
        const subtitleFile = new Blob([vtt], { type: 'text/vtt' });
        return { name: file.name, url: URL.createObjectURL(subtitleFile) };
      }));
      setSubtitles(subtitleTracks);
      setErrorMessage(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(`Could not load subtitles: ${message}`);
    }
  };

  useEffect(() => {
    if (!usbBrowserOpen) return;

    const controller = new AbortController();
    setIsLoadingUsb(true);
    setErrorMessage(null);
    fetch('/api/media/list', {
      cache: 'no-store',
      headers: { 'X-USB-Path': encodeHeaderValue(usbBrowserPath) },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(detail || `USB media query failed with HTTP ${response.status}`);
        }
        return response.json() as Promise<UsbMediaEntry[]>;
      })
      .then((entries) => setUsbEntries(entries.sort((a, b) =>
        Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name))))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(`Could not browse ESP32 media folder: ${message}`);
        setUsbEntries([]);
      })
      .finally(() => setIsLoadingUsb(false));

    return () => controller.abort();
  }, [usbBrowserOpen, usbBrowserPath]);

  const playUsbFile = (entry: UsbMediaEntry) => {
    const kind = getMediaKind({ name: entry.name, type: '' });
    if (!kind) {
      setErrorMessage('Choose an audio or video file. Subtitle files can be loaded with Add USB subtitles.');
      return;
    }
    if (!entry.sourcePath) {
      setErrorMessage('The ESP32 did not provide a playback path for this file.');
      return;
    }
    const url = `/api/media/file?physical=${encodeURIComponent(entry.sourcePath)}`;
    setTracks((previous) => {
      previous.forEach((track) => {
        if (track.source === 'local' && track.url.startsWith('blob:')) URL.revokeObjectURL(track.url);
      });
      return [{ name: entry.name, size: entry.size, url, kind, source: 'usb' }];
    });
    setTrackIndex(0);
    setSubtitles([]);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setErrorMessage(null);
    setUsbBrowserOpen(false);
  };

  const loadUsbSubtitles = async (entries: UsbMediaEntry[]) => {
    const selected = entries.filter((entry) => /\.(srt|vtt)$/i.test(entry.name));
    if (selected.length === 0) {
      setErrorMessage('No .srt or .vtt subtitle files were selected.');
      return;
    }
    try {
      const subtitleTracks = await Promise.all(selected.map(async (entry) => {
        if (!entry.sourcePath) throw new Error(`${entry.name}: playback path is unavailable`);
        const response = await fetch(`/api/media/file?physical=${encodeURIComponent(entry.sourcePath)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${entry.name}: HTTP ${response.status}`);
        const vtt = toWebVtt(await response.text(), entry.name);
        return {
          name: entry.name,
          url: URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })),
        };
      }));
      setSubtitles(subtitleTracks);
      setErrorMessage(null);
      setUsbBrowserOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(`Could not load USB subtitles: ${message}`);
    }
  };

  const playTrack = (index: number) => {
    if (index < 0 || index >= tracks.length) {
      return;
    }
    setTrackIndex(index);
    setSubtitles([]);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setErrorMessage(null);
  };

  const handleEnded = () => {
    if (trackIndex + 1 < tracks.length) {
      playTrack(trackIndex + 1);
    }
  };

  const togglePlayback = async () => {
    const media = mediaRef.current;
    if (!media) return;

    if (media.paused) {
      try {
        await media.play();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(`Could not start playback: ${message}`);
      }
    } else {
      media.pause();
    }
  };

  const setPlaybackVolume = (nextVolume: number) => {
    setVolume(nextVolume);
    if (mediaRef.current) mediaRef.current.volume = nextVolume;
  };

  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (mediaRef.current) mediaRef.current.muted = nextMuted;
  };

  useEffect(() => {
    if (mediaRef.current) {
      mediaRef.current.volume = volume;
      mediaRef.current.muted = isMuted;
    }
  }, [currentTrack?.url, isMuted, volume]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#111722] text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#171e2b] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300">
            <Disc3 className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">Media Player</h2>
            <p className="text-[11px] text-slate-400">Local or ESP32 USB audio/video · SRT and WebVTT subtitles</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setUsbBrowserPath('/media');
              setUsbBrowserOpen(true);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 transition-colors hover:bg-white/10"
          >
            <HardDrive className="h-4 w-4" />
            Browse ESP32 USB
          </button>
          {isVideo && currentTrack?.source === 'usb' && (
            <button
              type="button"
              onClick={() => {
                setUsbBrowserPath('/media');
                setUsbBrowserOpen(true);
              }}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 transition-colors hover:bg-white/10"
            >
              <Subtitles className="h-4 w-4" />
              Add USB subtitles
            </button>
          )}
          {isVideo && currentTrack?.source === 'local' && (
            <button
              type="button"
              onClick={() => subtitleInputRef.current?.click()}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 transition-colors hover:bg-white/10"
            >
              <Subtitles className="h-4 w-4" />
              Add subtitles
            </button>
          )}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-indigo-500"
          >
            Open media files
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,video/*,.aac,.aif,.aiff,.flac,.m4a,.m4v,.mka,.mkv,.mov,.mp3,.mp4,.oga,.ogg,.ogv,.opus,.wav,.webm,.weba,.wma,.wmv"
          multiple
          className="hidden"
          onChange={(event) => {
            openFiles(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
        <input
          ref={subtitleInputRef}
          type="file"
          accept=".srt,.vtt,text/vtt"
          multiple
          className="hidden"
          onChange={(event) => {
            void openSubtitles(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
      </div>

      {errorMessage && (
        <div role="alert" className="border-b border-red-500/20 bg-red-950/50 px-4 py-2 text-xs text-red-200">
          {errorMessage}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section className="flex min-h-0 flex-1 flex-col p-4">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/10 bg-black/40">
            {currentTrack ? (
              isVideo ? (
                <video
                  key={currentTrack.url}
                  ref={(media) => { mediaRef.current = media; }}
                  src={currentTrack.url}
                  autoPlay
                  playsInline
                  disablePictureInPicture
                  disableRemotePlayback
                  preload="metadata"
                  onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
                  onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={handleEnded}
                  onError={() => setErrorMessage('This video format or codec is not supported by the browser.')}
                  className="min-h-0 min-w-0 max-h-full max-w-full flex-1 self-center object-contain"
                >
                  {subtitles.map((subtitle, index) => (
                    <track
                      key={`${subtitle.name}-${index}`}
                      kind="subtitles"
                      src={subtitle.url}
                      srcLang="und"
                      label={subtitle.name.replace(/\.(srt|vtt)$/i, '') || `Subtitle ${index + 1}`}
                      default={index === 0}
                    />
                  ))}
                </video>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6 py-6 text-center">
                  <div className="flex h-32 w-32 shrink-0 items-center justify-center rounded-full border border-indigo-300/20 bg-indigo-500/10 text-indigo-200 shadow-[0_0_80px_rgba(99,102,241,0.15)]">
                    <Music2 className="h-16 w-16" />
                  </div>
                  <div className="w-full min-w-0">
                    <div className="truncate text-base font-semibold">{currentTrack.name}</div>
                    <div className="mt-1 text-xs text-slate-400">
                      {currentTrack.source === 'usb' ? 'ESP32 USB drive' : `${currentTrack.kind.toUpperCase()} file`} · {(currentTrack.size / (1024 * 1024)).toFixed(1)} MB
                    </div>
                  </div>
                  <audio
                    key={currentTrack.url}
                    ref={(media) => { mediaRef.current = media; }}
                    src={currentTrack.url}
                    autoPlay
                    preload="metadata"
                    onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
                    onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={handleEnded}
                    onError={() => setErrorMessage('This audio format or codec is not supported by the browser.')}
                    className="hidden"
                  />
                </div>
              )
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <div className="max-w-sm px-6 text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5 text-slate-400">
                    <FileAudio className="h-8 w-8" />
                  </div>
                  <h3 className="text-sm font-medium">Nothing playing</h3>
                  <p className="mt-2 text-xs leading-relaxed text-slate-400">
                    Browse ESP32 USB media or open files from this device. The browser handles playback; the ESP32 only streams files stored under its USB drive&apos;s <code>/media</code> folder.
                  </p>
                </div>
              </div>
            )}
            {currentTrack && (
              <div className="flex shrink-0 items-center gap-3 border-t border-white/10 bg-[#111722]/90 px-3 py-2">
                <button
                  type="button"
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                  onClick={() => void togglePlayback()}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white transition-colors hover:bg-indigo-500"
                >
                  {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}
                </button>
                <span className="shrink-0 font-mono text-[10px] text-slate-400">{formatTime(currentTime)}</span>
                <input
                  type="range"
                  aria-label="Seek"
                  min={0}
                  max={duration || 0}
                  step={0.1}
                  value={Math.min(currentTime, duration || 0)}
                  disabled={!duration}
                  onChange={(event) => {
                    const nextTime = Number(event.currentTarget.value);
                    if (mediaRef.current) mediaRef.current.currentTime = nextTime;
                    setCurrentTime(nextTime);
                  }}
                  className="h-1 min-w-0 flex-1 cursor-pointer accent-indigo-400 disabled:cursor-default"
                />
                <span className="shrink-0 font-mono text-[10px] text-slate-400">{formatTime(duration)}</span>
                <button
                  type="button"
                  aria-label={isMuted ? 'Unmute' : 'Mute'}
                  onClick={toggleMute}
                  className="shrink-0 rounded-md p-1.5 text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
                >
                  {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <input
                  type="range"
                  aria-label="Volume"
                  min={0}
                  max={1}
                  step={0.01}
                  value={isMuted ? 0 : volume}
                  onChange={(event) => {
                    const nextVolume = Number(event.currentTarget.value);
                    setPlaybackVolume(nextVolume);
                    setIsMuted(nextVolume === 0);
                    if (mediaRef.current) mediaRef.current.muted = nextVolume === 0;
                  }}
                  className="hidden h-1 w-16 cursor-pointer accent-indigo-400 sm:block"
                />
              </div>
            )}
          </div>

          {currentTrack && (
            <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-slate-400">
              <div className="flex min-w-0 items-center gap-2">
                {isVideo ? <FileVideo className="h-4 w-4 shrink-0 text-indigo-300" /> : <FileAudio className="h-4 w-4 shrink-0 text-indigo-300" />}
                <span className="truncate">{currentTrack.name}</span>
              </div>
            </div>
          )}

          <div className="mt-3 flex items-center justify-center gap-3">
            <button
              type="button"
              aria-label="Previous track"
              disabled={!currentTrack || trackIndex === 0}
              onClick={() => playTrack(trackIndex - 1)}
              className="rounded-lg p-2 text-slate-300 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <SkipBack className="h-5 w-5" />
            </button>
            <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <ListMusic className="h-4 w-4" />
              {tracks.length ? `${trackIndex + 1} / ${tracks.length}` : 'Playlist empty'}
            </span>
            <button
              type="button"
              aria-label="Next track"
              disabled={!currentTrack || trackIndex >= tracks.length - 1}
              onClick={() => playTrack(trackIndex + 1)}
              className="rounded-lg p-2 text-slate-300 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <SkipForward className="h-5 w-5" />
            </button>
          </div>
        </section>

        <aside className="flex max-h-52 min-h-0 flex-col border-t border-white/10 bg-black/10 md:max-h-none md:w-64 md:border-l md:border-t-0">
          <div className="border-b border-white/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Play queue
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {tracks.length ? tracks.map((track, index) => (
              <button
                key={`${track.source}-${track.name}-${track.size}-${index}`}
                type="button"
                onClick={() => playTrack(index)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left ${
                  index === trackIndex ? 'bg-indigo-500/15 text-indigo-100' : 'text-slate-300 hover:bg-white/5'
                }`}
              >
                {track.kind === 'video'
                  ? <FileVideo className="h-4 w-4 shrink-0 text-indigo-300" />
                  : <FileAudio className="h-4 w-4 shrink-0 text-indigo-300" />}
                <span className="truncate text-xs">{track.name}</span>
              </button>
            )) : (
              <p className="px-2 py-3 text-xs text-slate-500">Choose one or more files to start a queue.</p>
            )}
          </div>
        </aside>
      </div>

      {usbBrowserOpen && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 p-4">
          <section className="flex max-h-[80%] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-white/15 bg-[#171e2b] shadow-2xl">
            <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">ESP32 USB media</h3>
                <p className="mt-1 font-mono text-[11px] text-slate-400">{usbBrowserPath}</p>
              </div>
              <div className="flex gap-2">
                {usbBrowserPath !== '/media' && (
                  <button
                    type="button"
                    onClick={() => setUsbBrowserPath(usbBrowserPath.slice(0, usbBrowserPath.lastIndexOf('/')) || '/media')}
                    className="rounded-md border border-white/10 px-2.5 py-1.5 text-xs hover:bg-white/10"
                  >
                    Up
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setUsbBrowserOpen(false)}
                  className="rounded-md border border-white/10 px-2.5 py-1.5 text-xs hover:bg-white/10"
                >
                  Close
                </button>
              </div>
            </header>
            <div className="min-h-48 overflow-y-auto p-2">
              {isLoadingUsb ? (
                <p className="p-4 text-xs text-slate-400">Reading the ESP32 USB drive…</p>
              ) : usbEntries.length === 0 ? (
                <p className="p-4 text-xs text-slate-400">No files found. Put media and subtitle files in the USB drive&apos;s <code>/media</code> folder.</p>
              ) : (
                usbEntries.map((entry) => (
                  <div key={entry.path} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-white/5">
                    <button
                      type="button"
                      onClick={() => entry.isFolder
                        ? setUsbBrowserPath(entry.path)
                        : playUsbFile(entry)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-slate-200"
                    >
                      {entry.isFolder ? <ListMusic className="h-4 w-4 shrink-0 text-amber-300" /> : <FileVideo className="h-4 w-4 shrink-0 text-indigo-300" />}
                      <span className="truncate">{entry.name}</span>
                    </button>
                    {!entry.isFolder && isVideo && /\.(srt|vtt)$/i.test(entry.name) && (
                      <button
                        type="button"
                        onClick={() => void loadUsbSubtitles([entry])}
                        className="shrink-0 rounded-md border border-white/10 px-2 py-1 text-[10px] hover:bg-white/10"
                      >
                        Use subtitle
                      </button>
                    )}
                    {!entry.isFolder && (
                      <span className="shrink-0 text-[10px] text-slate-500">{(entry.size / (1024 * 1024)).toFixed(1)} MB</span>
                    )}
                  </div>
                ))
              )}
            </div>
            <footer className="border-t border-white/10 px-4 py-2 text-[10px] text-slate-500">
              Create <code>/media</code> on the flash drive and place playable media and subtitles there.
            </footer>
          </section>
        </div>
      )}
    </div>
  );
};
