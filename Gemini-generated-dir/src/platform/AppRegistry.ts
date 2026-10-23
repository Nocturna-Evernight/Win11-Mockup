/**
 * App Registry — Singleton that tracks all registered platform apps.
 *
 * Usage:
 *   import { appRegistry } from '../platform';
 *   appRegistry.register(myManifest);
 */

import type { AppManifest } from './types';

class AppRegistry {
  private readonly _apps = new Map<string, AppManifest>();
  private readonly _listeners = new Set<() => void>();

  /**
   * Register an app manifest. Throws if the ID is already taken.
   */
  register(manifest: AppManifest): void {
    if (this._apps.has(manifest.id)) {
      throw new Error(
        `[AppRegistry] App ID "${manifest.id}" is already registered. ` +
        `Use a unique kebab-case ID.`
      );
    }
    this._apps.set(manifest.id, manifest);
    console.info(
      `[AppRegistry] Registered "${manifest.name}" v${manifest.version} ` +
      `(id=${manifest.id}, permissions=[${manifest.permissions.join(', ')}])`
    );
    this._notify();
  }

  /**
   * Unregister an app by ID. Safe to call even if the app was never registered.
   */
  unregister(id: string): void {
    if (this._apps.delete(id)) {
      console.info(`[AppRegistry] Unregistered app "${id}"`);
      this._notify();
    }
  }

  /**
   * Returns the manifest for a given app ID, or undefined.
   */
  get(id: string): AppManifest | undefined {
    return this._apps.get(id) ?? Array.from(this._apps.values()).find((a) => a.id === id || a.appType === id);
  }

  /**
   * Returns all registered app manifests as an array.
   */
  getAll(): AppManifest[] {
    return Array.from(this._apps.values());
  }

  /**
   * Subscribe to registry changes (registrations / unregistrations).
   * Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private _notify(): void {
    this._listeners.forEach((fn) => fn());
  }
}

/** The global singleton registry. Import and use this across the app. */
export const appRegistry = new AppRegistry();
