/**
 * Platform Context & Provider
 *
 * Wraps the entire desktop and provides:
 *  - PlatformAPI to all hosted apps via usePlatform()
 *  - System-level toast notification rendering
 *  - Resource pressure state (polled from /api/platform/resources)
 *  - Inter-app message bus
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import type {
  AppManifest,
  AppPermission,
  PlatformAPI,
  ResourceSnapshot,
  PlatformToast,
  ToastKind,
  PlatformMessage,
  PlatformMessageHandler,
} from './types';
import type { FirmwareSystemSnapshot } from '../types';
import { AlertTriangle, CheckCircle, Info, XCircle } from 'lucide-react';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface PlatformContextValue {
  /** Create a bound PlatformAPI for a specific app manifest */
  createAppAPI: (manifest: AppManifest, cleanupFns: (() => void)[]) => PlatformAPI;
  /** Current hardware stats snapshot */
  hardwareStats: FirmwareSystemSnapshot | null;
  /** Current resource pressure */
  resourcePressure: ResourceSnapshot | null;
  /** Active toast notifications */
  toasts: PlatformToast[];
}

const PlatformContext = createContext<PlatformContextValue | null>(null);

// ---------------------------------------------------------------------------
// Message bus (simple in-memory pub/sub)
// ---------------------------------------------------------------------------

type MessageBus = {
  subscribe(appId: string, handler: PlatformMessageHandler): () => void;
  publish(msg: PlatformMessage): void;
};

function createMessageBus(): MessageBus {
  const subscribers = new Map<string, Set<PlatformMessageHandler>>();

  return {
    subscribe(appId, handler) {
      if (!subscribers.has(appId)) subscribers.set(appId, new Set());
      subscribers.get(appId)!.add(handler);
      return () => subscribers.get(appId)?.delete(handler);
    },
    publish(msg) {
      subscribers.get(msg.toAppId)?.forEach((h) => {
        try { h(msg); } catch (e) { console.error('[Platform:MessageBus]', e); }
      });
    },
  };
}

const globalBus = createMessageBus();

// ---------------------------------------------------------------------------
// Pressure subscribers (for onPressureChange)
// ---------------------------------------------------------------------------

const pressureSubscribers = new Set<(snap: ResourceSnapshot) => void>();
let latestPressure: ResourceSnapshot | null = null;

function notifyPressureSubscribers(snap: ResourceSnapshot) {
  latestPressure = snap;
  pressureSubscribers.forEach((fn) => {
    try { fn(snap); } catch (e) { console.error('[Platform:Pressure]', e); }
  });
}

// ---------------------------------------------------------------------------
// Permission guard helper
// ---------------------------------------------------------------------------

function assertPermission(manifest: AppManifest, permission: AppPermission): void {
  if (!manifest.permissions.includes(permission)) {
    throw new Error(
      `[Platform] App "${manifest.name}" (${manifest.id}) does not have ` +
      `the "${permission}" permission. Add it to your AppManifest.permissions array.`
    );
  }
}

// ---------------------------------------------------------------------------
// PlatformProvider
// ---------------------------------------------------------------------------

export interface PlatformProviderProps {
  children: React.ReactNode;
  /** Pass down hardware stats from App.tsx telemetry polling */
  hardwareStats: FirmwareSystemSnapshot | null;
}

export const PlatformProvider: React.FC<PlatformProviderProps> = ({
  children,
  hardwareStats,
}) => {
  const [toasts, setToasts] = useState<PlatformToast[]>([]);
  const [resourcePressure, setResourcePressure] = useState<ResourceSnapshot | null>(null);
  const toastTimers = useRef<Map<string, number>>(new Map());

  // ------ Resource pressure polling (/api/platform/resources) -------
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/platform/resources', { cache: 'no-store' });
        if (!cancelled && res.ok) {
          const snap = await res.json() as Omit<ResourceSnapshot, 'sampledAt'>;
          const full: ResourceSnapshot = { ...snap, sampledAt: Date.now() };
          setResourcePressure(full);
          notifyPressureSubscribers(full);
        }
      } catch { /* device may be temporarily unreachable */ }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 2000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // ------ Toast management ------------------------------------------
  const showToast = useCallback((
    appName: string,
    message: string,
    kind: ToastKind = 'info'
  ) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const toast: PlatformToast = {
      id,
      message,
      kind,
      appName,
      expiresAt: Date.now() + 4000,
    };
    setToasts((prev) => [...prev.slice(-4), toast]); // keep last 5
    const timer = window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      toastTimers.current.delete(id);
    }, 4200);
    toastTimers.current.set(id, timer);
  }, []);

  // ------ Factory: bound PlatformAPI for each app instance ----------
  const createAppAPI = useCallback(
    (manifest: AppManifest, cleanupFns: (() => void)[]): PlatformAPI => {
      const activeFetches = new Set<AbortController>();

      return {
        manifest,

        openApp(appId, data) {
          assertPermission(manifest, 'openApps');
          // Dispatch a custom event that App.tsx listens to
          window.dispatchEvent(
            new CustomEvent('platform:openApp', { detail: { appId, data } })
          );
        },

        showToast(message, kind = 'info') {
          assertPermission(manifest, 'notifications');
          showToast(manifest.name, message, kind);
        },

        fetch(url, options) {
          assertPermission(manifest, 'network');
          // Only allow /api/* or relative paths
          if (url.startsWith('http') && !url.includes('/api/')) {
            throw new Error(
              `[Platform] App "${manifest.id}" attempted a cross-origin fetch to "${url}". ` +
              `Only /api/* paths are permitted.`
            );
          }
          const ac = new AbortController();
          activeFetches.add(ac);
          const signal = options?.signal
            ? options.signal
            : ac.signal;
          return fetch(url, { ...options, signal }).finally(() => {
            activeFetches.delete(ac);
          });
        },

        getHardwareStats() {
          assertPermission(manifest, 'hardware');
          return hardwareStats;
        },

        getResourcePressure() {
          return latestPressure;
        },

        onPressureChange(cb) {
          pressureSubscribers.add(cb);
          return () => pressureSubscribers.delete(cb);
        },

        sendMessage(toAppId, topic, payload) {
          assertPermission(manifest, 'interAppMessage');
          globalBus.publish({
            fromAppId: manifest.id,
            toAppId,
            topic,
            payload,
            sentAt: Date.now(),
          });
        },

        onMessage(handler) {
          assertPermission(manifest, 'interAppMessage');
          const unsub = globalBus.subscribe(manifest.id, handler);
          cleanupFns.push(unsub);
          return unsub;
        },

        registerCleanup(fn) {
          cleanupFns.push(fn);
          // Also abort in-flight fetches on cleanup
          cleanupFns.push(() => activeFetches.forEach((ac) => ac.abort()));
        },
      };
    },
    [hardwareStats, showToast]
  );

  const value = useMemo<PlatformContextValue>(
    () => ({ createAppAPI, hardwareStats, resourcePressure, toasts }),
    [createAppAPI, hardwareStats, resourcePressure, toasts]
  );

  return (
    <PlatformContext.Provider value={value}>
      {children}
      {/* System-level toast notification stack */}
      <PlatformToastStack toasts={toasts} onDismiss={(id) =>
        setToasts((prev) => prev.filter((t) => t.id !== id))
      } />
    </PlatformContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Toast stack renderer
// ---------------------------------------------------------------------------

const TOAST_ICONS: Record<ToastKind, React.ReactNode> = {
  info:    <Info className="w-4 h-4 text-blue-400 shrink-0" />,
  success: <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />,
  warning: <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />,
  error:   <XCircle className="w-4 h-4 text-red-400 shrink-0" />,
};

const TOAST_BORDER: Record<ToastKind, string> = {
  info:    'border-blue-700/40',
  success: 'border-emerald-700/40',
  warning: 'border-amber-700/40',
  error:   'border-red-700/40',
};

function PlatformToastStack({
  toasts,
  onDismiss,
}: {
  toasts: PlatformToast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed top-4 right-4 z-[9800] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl bg-neutral-900/95 backdrop-blur-xl border ${TOAST_BORDER[t.kind]} shadow-2xl text-xs text-slate-100 max-w-xs animate-in slide-in-from-right-4 fade-in duration-200`}
        >
          {TOAST_ICONS[t.kind]}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-[10px] text-slate-400 leading-none mb-0.5">{t.appName}</p>
            <p className="leading-snug">{t.message}</p>
          </div>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            className="text-slate-500 hover:text-slate-200 leading-none pl-1"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook: usePlatform()
// ---------------------------------------------------------------------------

/**
 * Returns a bound PlatformAPI for the calling app.
 * Must be used inside an <AppSandbox> which passes the manifest and cleanupFns.
 *
 * @internal — apps should use usePlatform() from the sandbox context, not directly.
 */
export function usePlatformContext(): PlatformContextValue {
  const ctx = useContext(PlatformContext);
  if (!ctx) {
    throw new Error(
      '[usePlatform] Must be used inside <PlatformProvider>. ' +
      'Wrap your <App> root with <PlatformProvider>.'
    );
  }
  return ctx;
}

// App-level sandbox context (set by AppSandbox, consumed by usePlatform)
export const AppPlatformAPIContext = createContext<PlatformAPI | null>(null);

/**
 * Hook used inside app components to access the Platform API.
 *
 * @example
 * const platform = usePlatform();
 * platform.showToast('Hello world!', 'success');
 */
export function usePlatform(): PlatformAPI {
  const api = useContext(AppPlatformAPIContext);
  if (!api) {
    throw new Error(
      '[usePlatform] Must be used inside a platform-hosted app component ' +
      '(i.e. wrapped by <AppSandbox>).'
    );
  }
  return api;
}
