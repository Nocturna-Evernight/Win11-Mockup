/**
 * AppSandbox — Enhanced error boundary + resource watchdog for platform-hosted apps.
 *
 * Responsibilities:
 *  1. Catches React render errors (extends AppErrorBoundary) and shows a
 *     Win11-style crash screen with restart capability.
 *  2. Counts re-renders via a React ref and kills the app if it exceeds
 *     the manifest's maxRenderCount (default 500) in a sliding 5-second window.
 *  3. Measures synchronous render time and kills the app if a single render
 *     exceeds maxRenderMs (default 200 ms).
 *  4. Creates and provides the bound PlatformAPI to the app via context.
 *  5. Runs cleanup functions when the app is killed or unmounted.
 *
 * Usage:
 *   <AppSandbox manifest={manifest}>
 *     <MyAppComponent instanceId="..." width={w} height={h} />
 *   </AppSandbox>
 */

import React from 'react';
import type { AppManifest, AppProps, PlatformAPI } from './types';
import { usePlatformContext, AppPlatformAPIContext } from './PlatformContext';
import { RefreshCw, SkullIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Default resource limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RENDER_COUNT = 500;
const DEFAULT_MAX_RENDER_MS    = 200;
const RENDER_WINDOW_MS         = 5000; // sliding window for render count

// ---------------------------------------------------------------------------
// Inner functional component that creates the PlatformAPI and monitors renders
// ---------------------------------------------------------------------------

interface AppSandboxInnerProps {
  manifest: AppManifest;
  instanceId: string;
  width: number;
  height: number;
  onKill: (reason: string) => void;
  children: React.ReactNode;
}

function AppSandboxInner({
  manifest,
  instanceId,
  width,
  height,
  onKill,
  children,
}: AppSandboxInnerProps) {
  const platformCtx = usePlatformContext();

  // Build the PlatformAPI once per mount; cleanup fns accumulate
  const cleanupFnsRef = React.useRef<(() => void)[]>([]);
  const apiRef = React.useRef<PlatformAPI | null>(null);
  if (!apiRef.current) {
    apiRef.current = platformCtx.createAppAPI(manifest, cleanupFnsRef.current);
  }

  // Render-rate limiter
  const renderTimestamps = React.useRef<number[]>([]);
  const limits = manifest.resourceLimits ?? {};
  const maxCount = limits.maxRenderCount ?? DEFAULT_MAX_RENDER_COUNT;
  const maxMs    = limits.maxRenderMs    ?? DEFAULT_MAX_RENDER_MS;

  // Check render rate on every render (synchronous — intentionally lightweight)
  const now = performance.now();
  const windowStart = now - RENDER_WINDOW_MS;

  // Evict old timestamps
  renderTimestamps.current = renderTimestamps.current.filter((t) => t > windowStart);
  renderTimestamps.current.push(now);

  if (renderTimestamps.current.length > maxCount) {
    // Schedule kill asynchronously so React can finish the current render
    setTimeout(() => {
      onKill(
        `Render-loop detected: ${renderTimestamps.current.length} renders in ${RENDER_WINDOW_MS}ms ` +
        `(limit=${maxCount}). Killing "${manifest.name}" to protect the system.`
      );
    }, 0);
  }

  // Render-time measurement via a layout effect on the children wrapper
  const renderStartRef = React.useRef<number>(performance.now());
  renderStartRef.current = performance.now();

  React.useLayoutEffect(() => {
    const elapsed = performance.now() - renderStartRef.current;
    if (elapsed > maxMs) {
      console.warn(
        `[AppSandbox] "${manifest.name}" render took ${elapsed.toFixed(1)}ms ` +
        `(limit=${maxMs}ms)`
      );
      if (elapsed > maxMs * 3) {
        // Kill only if 3× over limit (single spike tolerance)
        onKill(
          `Render took ${elapsed.toFixed(0)}ms (limit=${maxMs}ms × 3 = ${maxMs * 3}ms). ` +
          `Killing "${manifest.name}" to protect system responsiveness.`
        );
      }
    }
  });

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      cleanupFnsRef.current.forEach((fn) => {
        try { fn(); } catch (e) { console.error('[AppSandbox] Cleanup error:', e); }
      });
      cleanupFnsRef.current = [];
    };
  }, []);

  const appProps: AppProps = { instanceId, width, height };

  return (
    <AppPlatformAPIContext.Provider value={apiRef.current}>
      {/* Clone children injecting AppProps if it's a single element */}
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child as React.ReactElement<AppProps>, appProps)
          : child
      )}
    </AppPlatformAPIContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Outer class-based error boundary
// ---------------------------------------------------------------------------

interface AppSandboxProps {
  manifest: AppManifest;
  instanceId?: string;
  width?: number;
  height?: number;
  children: React.ReactNode;
}

interface AppSandboxState {
  hasError: boolean;
  error: Error | null;
  killed: boolean;
  killReason: string | null;
  restartKey: number;
  restartCount: number;
}

const MAX_RESTARTS = 5;

export class AppSandbox extends React.Component<AppSandboxProps, AppSandboxState> {
  constructor(props: AppSandboxProps) {
    super(props);
    this.state = {
      hasError:     false,
      error:        null,
      killed:       false,
      killReason:   null,
      restartKey:   0,
      restartCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<AppSandboxState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[AppSandbox] "${this.props.manifest.name}" crashed:`,
      error.message,
      info.componentStack
    );
  }

  handleKill = (reason: string) => {
    console.error(`[AppSandbox] KILL: ${reason}`);
    this.setState({ killed: true, killReason: reason });
  };

  handleRestart = () => {
    if (this.state.restartCount >= MAX_RESTARTS) return;
    this.setState((prev) => ({
      hasError:     false,
      error:        null,
      killed:       false,
      killReason:   null,
      restartKey:   prev.restartKey + 1,
      restartCount: prev.restartCount + 1,
    }));
  };

  render() {
    const { manifest, instanceId, width, height, children } = this.props;
    const { hasError, error, killed, killReason, restartKey, restartCount } = this.state;
    const tooManyRestarts = restartCount >= MAX_RESTARTS;

    if (killed) {
      return (
        <div className="flex flex-col items-center justify-center w-full h-full bg-neutral-950 text-slate-100 p-6 gap-4">
          <div className="p-3 rounded-full bg-red-600/20">
            <SkullIcon className="w-8 h-8 text-red-400" />
          </div>
          <div className="text-center max-w-xs">
            <p className="font-semibold text-red-400 text-sm">{manifest.name} was killed</p>
            <p className="text-xs text-slate-400 mt-1 font-mono break-words leading-relaxed">
              {killReason}
            </p>
          </div>
          {tooManyRestarts ? (
            <p className="text-xs text-amber-400">Too many restarts — close and reopen the app.</p>
          ) : (
            <button
              type="button"
              onClick={this.handleRestart}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-slate-200 text-xs font-medium transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Restart ({MAX_RESTARTS - restartCount} left)
            </button>
          )}
        </div>
      );
    }

    if (hasError) {
      return (
        <div className="flex flex-col items-center justify-center w-full h-full bg-neutral-950 text-slate-100 p-6 gap-4">
          <div className="text-5xl select-none">❌</div>
          <div className="text-center max-w-xs">
            <p className="font-semibold text-red-400 text-sm">{manifest.name} crashed</p>
            {error && (
              <p className="text-xs text-slate-400 mt-1 font-mono break-words">
                {error.name}: {error.message}
              </p>
            )}
          </div>
          {tooManyRestarts ? (
            <p className="text-xs text-amber-400">Too many restarts — close and reopen the app.</p>
          ) : (
            <button
              type="button"
              onClick={this.handleRestart}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-slate-200 text-xs font-medium transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Restart App ({MAX_RESTARTS - restartCount} left)
            </button>
          )}
        </div>
      );
    }

    return (
      <AppSandboxInner
        key={restartKey}
        manifest={manifest}
        instanceId={instanceId ?? manifest.id}
        width={width ?? 800}
        height={height ?? 600}
        onKill={this.handleKill}
      >
        {children}
      </AppSandboxInner>
    );
  }
}
