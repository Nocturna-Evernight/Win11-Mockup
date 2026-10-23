/**
 * App Platform — Core Types
 *
 * Defines the contract every platform-hosted app must satisfy,
 * the API surface exposed to apps, and the resource-pressure types
 * mirrored from the ESP32-S3 firmware watchdog.
 */

import React from 'react';
import type { WindowAppType, FirmwareSystemSnapshot } from '../types';

// ---------------------------------------------------------------------------
// Permission system
// ---------------------------------------------------------------------------

/** Capabilities an app may declare it needs. */
export type AppPermission =
  | 'network'          // call fetch() to /api/* endpoints
  | 'filesystem'       // read/write to virtual filesystem
  | 'hardware'         // read GPIO / hardware stats
  | 'notifications'    // show system toast notifications
  | 'openApps'         // launch other apps via platform.openApp()
  | 'interAppMessage'  // send/receive messages between apps
  | 'audio'            // use MediaPlayer / audio output
  | 'ota';             // trigger OTA updates (elevated permission)

// ---------------------------------------------------------------------------
// Resource limits
// ---------------------------------------------------------------------------

/** Per-app resource budget. Exceeding any limit triggers a kill signal. */
export interface AppResourceLimits {
  /** Max consecutive React renders before the sandbox kills the app. Default 500. */
  maxRenderCount?: number;
  /** Max time (ms) a single synchronous render may take. Default 200. */
  maxRenderMs?: number;
  /** Max pending fetch() calls at once. Default 4. */
  maxConcurrentFetches?: number;
}

// ---------------------------------------------------------------------------
// App Manifest
// ---------------------------------------------------------------------------

/** Props passed by the platform to every hosted app component. */
export interface AppProps {
  /** Stable app instance ID (same as manifest.id + window index). */
  instanceId: string;
  /** Read-only window size from the window frame. */
  width: number;
  height: number;
}

/**
 * App Manifest — declare this to register an app with the platform.
 * Think of it as the package.json + window config for your mini-app.
 */
export interface AppManifest {
  /** Unique kebab-case ID, e.g. "my-clock-app" */
  id: string;
  /** Human-readable display name */
  name: string;
  /** SemVer string, e.g. "1.0.0" */
  version: string;
  /** Author name or handle */
  author?: string;
  /** Short description shown in the app launcher */
  description: string;
  /** Emoji string or JSX element shown as the app icon */
  icon: string | React.ReactNode;
  /** Tailwind background colour class for the launcher tile, e.g. "bg-violet-500/10" */
  tileColor: string;
  /**
   * The WindowAppType key this app will use. Must be unique and added to
   * WindowAppType in src/types/index.ts by the developer.
   * Apps without a WindowAppType can still launch as modal overlays via
   * platform.openApp() but won't have a taskbar entry.
   */
  appType?: WindowAppType;
  /** Permissions this app requires. The platform will warn on first launch. */
  permissions: AppPermission[];
  /** Resource limits — defaults apply if omitted. */
  resourceLimits?: AppResourceLimits;
  /** Window geometry defaults */
  windowDefaults: {
    width: number;
    height: number;
    minWidth?: number;
    minHeight?: number;
  };
  /** The React component to render inside the window frame. */
  component: React.ComponentType<AppProps>;
}

// ---------------------------------------------------------------------------
// Platform pressure (mirrors ESP32 firmware watchdog levels)
// ---------------------------------------------------------------------------

export type PressureLevel = 'none' | 'low' | 'critical' | 'emergency';

export interface ResourceSnapshot {
  pressureLevel: PressureLevel;
  internalFreeBytes: number;
  internalMinFreeBytes: number;
  psramFreeBytes: number;
  httpSuspended: boolean;
  emergencyCount: number;
  /** Timestamp of this snapshot */
  sampledAt: number;
}

// ---------------------------------------------------------------------------
// Toast notification type used by platform.showToast()
// ---------------------------------------------------------------------------

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface PlatformToast {
  id: string;
  message: string;
  kind: ToastKind;
  appName: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Inter-app messaging
// ---------------------------------------------------------------------------

export interface PlatformMessage {
  fromAppId: string;
  toAppId: string;
  topic: string;
  payload: unknown;
  sentAt: number;
}

export type PlatformMessageHandler = (msg: PlatformMessage) => void;

// ---------------------------------------------------------------------------
// Public Platform API surface exposed to app components via usePlatform()
// ---------------------------------------------------------------------------

export interface PlatformAPI {
  /** The manifest of the calling app */
  readonly manifest: AppManifest;

  /**
   * Open another registered app (requires 'openApps' permission).
   * @param appId  The target app's manifest ID or WindowAppType string.
   * @param data   Optional data forwarded to the app.
   */
  openApp(appId: string, data?: unknown): void;

  /**
   * Show a system-level toast notification (requires 'notifications' permission).
   */
  showToast(message: string, kind?: ToastKind): void;

  /**
   * Fetch from the device REST API (requires 'network' permission).
   * Only URLs starting with /api/ or relative paths are allowed.
   * Requests are tracked and automatically aborted when the app is killed.
   */
  fetch(url: string, options?: RequestInit): Promise<Response>;

  /**
   * Get the latest hardware snapshot (requires 'hardware' permission).
   * Returns null if telemetry is unavailable.
   */
  getHardwareStats(): FirmwareSystemSnapshot | null;

  /**
   * Get the current device resource pressure snapshot.
   * Always available — no permission required.
   */
  getResourcePressure(): ResourceSnapshot | null;

  /**
   * Subscribe to resource pressure changes.
   * The callback is fired whenever the pressure level changes.
   * Returns an unsubscribe function.
   */
  onPressureChange(cb: (snap: ResourceSnapshot) => void): () => void;

  /**
   * Send a message to another running app (requires 'interAppMessage' permission).
   */
  sendMessage(toAppId: string, topic: string, payload: unknown): void;

  /**
   * Subscribe to messages sent to this app (requires 'interAppMessage' permission).
   * Returns an unsubscribe function.
   */
  onMessage(handler: PlatformMessageHandler): () => void;

  /**
   * Register a cleanup function called when the app is force-killed.
   * Use this to cancel timers, close connections, etc.
   */
  registerCleanup(fn: () => void): void;
}
