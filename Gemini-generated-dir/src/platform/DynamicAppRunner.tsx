/**
 * Dynamic App Runner & Sandboxed HTML/JS Host
 *
 * Runs user-authored mini-apps and HTML5 games imported directly via the WebUI
 * inside a secure, origin-isolated iframe sandbox with postMessage bridge.
 */

import React, { useRef, useEffect, useState } from 'react';
import { usePlatform } from './PlatformContext';
import { AlertTriangle, Play, RefreshCw, Terminal } from 'lucide-react';

interface DynamicAppRunnerProps {
  appCode: string;
  appName?: string;
  width?: number;
  height?: number;
}

export const DynamicAppRunner: React.FC<DynamicAppRunnerProps> = ({
  appCode,
  appName = 'Custom Web App',
  width,
  height,
}) => {
  const platform = usePlatform();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [consoleLogs, setConsoleLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const bridgeScript = `
    <script>
      (function() {
        const _log = console.log;
        const _err = console.error;
        console.log = (...args) => {
          _log(...args);
          window.parent.postMessage({ type: 'CONSOLE_LOG', payload: args.map(String).join(' ') }, '*');
        };
        console.error = (...args) => {
          _err(...args);
          window.parent.postMessage({ type: 'CONSOLE_ERROR', payload: args.map(String).join(' ') }, '*');
        };
        window.onerror = (msg, url, line) => {
          window.parent.postMessage({ type: 'RUNTIME_ERROR', payload: msg + ' (line ' + line + ')' }, '*');
        };

        window.ESP32 = {
          showToast: (msg, kind = 'info') => {
            window.parent.postMessage({ type: 'SHOW_TOAST', payload: { msg, kind } }, '*');
          },
          openApp: (appId) => {
            window.parent.postMessage({ type: 'OPEN_APP', payload: appId }, '*');
          }
        };
      })();
    </script>
  `;

  let wrappedSrcDoc = '';
  const trimmedCode = appCode.trim();
  const isFullHtml = /^<!doctype html/i.test(trimmedCode) || /^<html/i.test(trimmedCode);

  if (isFullHtml) {
    if (/<head[^>]*>/i.test(trimmedCode)) {
      wrappedSrcDoc = trimmedCode.replace(/(<head[^>]*>)/i, `$1${bridgeScript}`);
    } else if (/<body[^>]*>/i.test(trimmedCode)) {
      wrappedSrcDoc = trimmedCode.replace(/(<body[^>]*>)/i, `$1${bridgeScript}`);
    } else {
      wrappedSrcDoc = `${bridgeScript}${trimmedCode}`;
    }
  } else {
    wrappedSrcDoc = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      overflow-x: hidden;
    }
    button {
      cursor: pointer;
      background: #2563eb;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-weight: 500;
      transition: background 0.2s;
    }
    button:hover { background: #1d4ed8; }
  </style>
  ${bridgeScript}
</head>
<body>
  ${trimmedCode.startsWith('<') ? trimmedCode : `<script>${trimmedCode}</script>`}
</body>
</html>
    `;
  }

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;
      const { type, payload } = e.data;

      if (type === 'CONSOLE_LOG') {
        setConsoleLogs((prev) => [...prev.slice(-49), payload]);
      } else if (type === 'CONSOLE_ERROR' || type === 'RUNTIME_ERROR') {
        setErrorMsg(payload);
        setConsoleLogs((prev) => [...prev.slice(-49), `[ERR]: ${payload}`]);
      } else if (type === 'SHOW_TOAST') {
        platform.showToast(payload.msg, payload.kind);
      } else if (type === 'OPEN_APP') {
        platform.openApp(payload);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [platform]);

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 overflow-hidden">
      {errorMsg && (
        <div className="flex items-center gap-2 p-2.5 bg-red-950/80 border-b border-red-800 text-xs text-red-200">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <span className="truncate">{errorMsg}</span>
          <button
            onClick={() => setErrorMsg(null)}
            className="ml-auto text-xs text-red-400 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      {/* Sandboxed execution container */}
      <div className="flex-1 w-full h-full relative">
        <iframe
          ref={iframeRef}
          title={appName}
          sandbox="allow-scripts allow-modals"
          srcDoc={wrappedSrcDoc}
          className="w-full h-full border-none bg-slate-900"
        />
      </div>

      {/* Collapsible output console */}
      {consoleLogs.length > 0 && (
        <div className="h-28 border-t border-slate-800 bg-black/80 font-mono text-[11px] p-2.5 overflow-y-auto space-y-1 text-slate-300">
          <div className="text-[10px] text-slate-500 uppercase font-sans font-semibold tracking-wider mb-1 flex items-center gap-1.5">
            <Terminal className="w-3 h-3 text-cyan-400" />
            <span>Sandbox Output</span>
          </div>
          {consoleLogs.map((log, idx) => (
            <div key={idx} className="leading-tight">{log}</div>
          ))}
        </div>
      )}
    </div>
  );
};
