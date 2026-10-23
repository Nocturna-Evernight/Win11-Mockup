import { UserProfile, WindowAppType } from '../types';

const USERS_STORAGE_KEY = 'esp32s3_win11_users_v3';
const CURRENT_USER_KEY = 'esp32s3_win11_current_user_v3';
const DESKTOP_STATE_KEY = 'esp32s3_win11_desktop_state_v1';
const ACCOUNT_STATE_ENDPOINT = '/api/account/state';
const MAX_ACCOUNT_STATE_BYTES = 2 * 1024 * 1024;

export interface PersistedWindowState {
  appType: WindowAppType;
  isOpen: boolean;
  isMinimized: boolean;
  isMaximized: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AccountOfficeState {
  documentTitle: string;
  documentBody: string;
  grid: string[][];
  slides: { title: string; body: string }[];
}

export interface AccountDesktopState {
  wallpaper?: string;
  windows?: PersistedWindowState[];
  activeAppType?: WindowAppType | null;
  office?: AccountOfficeState;
}

interface StoredAccountState {
  schemaVersion: 1;
  users: UserProfile[];
  currentUserId: string;
  desktop: Record<string, AccountDesktopState>;
}

export type AccountSyncState = 'loading' | 'connected' | 'offline';

// Pre-computed SHA-256 hashes:
// "password" -> 5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8

export function generateInitialsAvatar(name: string, bgColor: string = '#2563eb'): string {
  const initials = (name || 'U')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(p => p[0])
    .join('')
    .substring(0, 2)
    .toUpperCase() || 'W';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
    <defs>
      <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${bgColor}" />
        <stop offset="100%" stop-color="#0f172a" />
      </linearGradient>
    </defs>
    <rect width="200" height="200" rx="100" fill="url(#grad)" />
    <circle cx="100" cy="100" r="94" stroke="#ffffff" stroke-opacity="0.15" stroke-width="4" fill="none" />
    <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" font-weight="700" font-size="72" fill="#ffffff" letter-spacing="-2">${initials}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const PRESET_AVATARS = [
  { id: 'av_1', name: 'Software Engineer', url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=200&q=80' },
  { id: 'av_2', name: 'Security Administrator', url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80' },
  { id: 'av_3', name: 'Hardware Designer', url: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=200&q=80' },
  { id: 'av_4', name: 'Embedded Developer', url: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=200&q=80' },
  { id: 'av_5', name: 'Robotics Specialist', url: 'https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?auto=format&fit=crop&w=200&q=80' },
  { id: 'av_6', name: 'Minimalist Silhouette', url: 'https://images.unsplash.com/photo-1511367461989-f85a21fda167?auto=format&fit=crop&w=200&q=80' },
  { id: 'av_7', name: 'Blue Cyber Initial', url: generateInitialsAvatar('Windows 11', '#0284c7') },
  { id: 'av_8', name: 'Emerald Microchip', url: generateInitialsAvatar('ESP32 S3', '#059669') },
  { id: 'av_9', name: 'Violet Security', url: generateInitialsAvatar('Admin User', '#7c3aed') },
  { id: 'av_10', name: 'Amber Hardware', url: generateInitialsAvatar('USB MSC', '#d97706') },
];

const DEFAULT_USERS: UserProfile[] = [
  {
    id: 'user_admin',
    username: 'Administrator',
    displayName: 'System Administrator',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80',
    isAdmin: true,
    hasPassword: true,
    passwordHash: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
    uacLevel: 2, // Default: Prompt with Dim Desktop
    createdDate: '2026-10-01',
  },
  {
    id: 'user_kennard',
    username: 'Kennard',
    displayName: 'Kennard Devida',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=200&q=80',
    isAdmin: true,
    hasPassword: true,
    passwordHash: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
    uacLevel: 2,
    createdDate: '2026-10-02',
  },
  {
    id: 'user_guest',
    username: 'Guest',
    displayName: 'Guest Account',
    avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=200&q=80',
    isAdmin: false,
    hasPassword: false,
    passwordHash: '',
    uacLevel: 3, // Always notify & prompt for admin credentials
    createdDate: '2026-10-03',
  }
];

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Fallback(message: Uint8Array): Uint8Array {
  const bitLength = message.length * 8;
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  paddedView.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotateRight = (value: number, amount: number): number =>
    (value >>> amount) | (value << (32 - amount));

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      words[i] = paddedView.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16] + sigma0 + words[i - 7] + sigma1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < hash.length; i++) {
    digestView.setUint32(i * 4, hash[i], false);
  }
  return digest;
}

function isUserProfile(value: unknown): value is UserProfile {
  if (typeof value !== 'object' || value === null) return false;
  const user = value as Record<string, unknown>;
  return typeof user.id === 'string' && user.id.length > 0 &&
    typeof user.username === 'string' && user.username.length > 0 &&
    typeof user.displayName === 'string' &&
    typeof user.avatar === 'string' &&
    typeof user.isAdmin === 'boolean' &&
    typeof user.hasPassword === 'boolean' &&
    typeof user.passwordHash === 'string' &&
    typeof user.uacLevel === 'number' && Number.isInteger(user.uacLevel) &&
    user.uacLevel >= 0 && user.uacLevel <= 3 &&
    typeof user.createdDate === 'string';
}

function isDesktopState(value: unknown): value is AccountDesktopState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  if (state.wallpaper !== undefined && typeof state.wallpaper !== 'string') return false;
  if (state.activeAppType !== undefined &&
      state.activeAppType !== null && typeof state.activeAppType !== 'string') return false;
  if (state.office !== undefined) {
    if (typeof state.office !== 'object' || state.office === null) return false;
    const office = state.office as Record<string, unknown>;
    if (typeof office.documentTitle !== 'string' ||
        typeof office.documentBody !== 'string' ||
        !Array.isArray(office.grid) ||
        !office.grid.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string')) ||
        !Array.isArray(office.slides) ||
        office.slides.length === 0 ||
        !office.slides.every((slide) =>
          typeof slide === 'object' && slide !== null &&
          typeof (slide as Record<string, unknown>).title === 'string' &&
          typeof (slide as Record<string, unknown>).body === 'string')) {
      return false;
    }
  }
  if (state.windows !== undefined) {
    if (!Array.isArray(state.windows) || state.windows.length > 32) return false;
    if (!state.windows.every((item) => {
      if (typeof item !== 'object' || item === null) return false;
      const win = item as Record<string, unknown>;
      return typeof win.appType === 'string' &&
        typeof win.isOpen === 'boolean' &&
        typeof win.isMinimized === 'boolean' &&
        typeof win.isMaximized === 'boolean' &&
        ['x', 'y', 'width', 'height'].every((key) =>
          typeof win[key] === 'number' && Number.isFinite(win[key]));
    })) return false;
  }
  return true;
}

export async function hashPassword(plain: string): Promise<string> {
  if (!plain) return '';
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const subtle = globalThis.crypto?.subtle;
  const hashArray = subtle
    ? Array.from(new Uint8Array(await subtle.digest('SHA-256', data)))
    : Array.from(sha256Fallback(data));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

class AuthService {
  private users: UserProfile[];
  private currentUser: UserProfile;
  private desktopStates: Record<string, AccountDesktopState>;
  private listeners: (() => void)[] = [];
  private remoteSaveRunning = false;
  private remoteSavePending = false;
  private remoteSaveWaiters: ((saved: boolean) => void)[] = [];
  private syncState: AccountSyncState = 'loading';
  private syncError: string | null = null;

  constructor() {
    this.users = this.loadUsers();
    this.currentUser = this.loadCurrentUser();
    this.desktopStates = this.loadDesktopStates();
  }

  public async initialize(): Promise<void> {
    this.setSyncState('loading');
    try {
      const response = await fetch(ACCOUNT_STATE_ENDPOINT, { cache: 'no-store' });
      if (response.ok) {
        const state: unknown = await response.json();
        if (typeof state !== 'object' || state === null) {
          throw new Error('Device returned an invalid account-state document.');
        }
        const stored = state as Record<string, unknown>;
        const users = stored.users;
        const desktop = stored.desktop;
        const currentUserId = stored.currentUserId;
        if (stored.schemaVersion !== 1 || !Array.isArray(users) ||
            !users.every(isUserProfile) || users.length === 0 ||
            typeof currentUserId !== 'string' ||
            !users.some((user) => user.id === currentUserId) ||
            typeof desktop !== 'object' || desktop === null ||
            !Object.values(desktop).every(isDesktopState)) {
          throw new Error('Device account state does not match the supported schema.');
        }
        this.users = users;
        this.currentUser = users.find((user) => user.id === currentUserId) ?? users[0];
        this.desktopStates = desktop as Record<string, AccountDesktopState>;
        this.saveLocalState();
        this.setSyncState('connected');
      } else if (response.status === 404) {
        const saved = await this.queueRemoteSave();
        if (!saved) {
          throw new Error('The ESP32 has no saved account state and could not initialize it.');
        }
      } else {
        throw new Error(`Device account-state query failed with HTTP ${response.status}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown device synchronization error.';
      this.setSyncState('offline', message);
      console.error('Shared account storage is unavailable; this browser is using its local cache.', error);
    }
  }

  private loadUsers(): UserProfile[] {
    try {
      const stored = localStorage.getItem(USERS_STORAGE_KEY);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isUserProfile)) {
          return parsed;
        }
        console.warn('Stored users are invalid; using default accounts.');
      }
    } catch (e) {
      console.warn('Failed to load users from localStorage:', e);
    }
    return DEFAULT_USERS;
  }

  private saveUsers(): void {
    this.persistState();
    this.notify();
  }

  private loadDesktopStates(): Record<string, AccountDesktopState> {
    try {
      const stored = localStorage.getItem(DESKTOP_STATE_KEY);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (typeof parsed === 'object' && parsed !== null &&
            Object.values(parsed).every(isDesktopState)) {
          return parsed as Record<string, AccountDesktopState>;
        }
        console.warn('Stored desktop preferences are invalid; using default desktop settings.');
      }
    } catch (e) {
      console.warn('Failed to load desktop preferences from localStorage:', e);
    }
    return {};
  }

  private createStoredState(): StoredAccountState {
    return {
      schemaVersion: 1,
      users: this.users,
      currentUserId: this.currentUser.id,
      desktop: this.desktopStates,
    };
  }

  private saveLocalState(): void {
    try {
      localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(this.users));
      localStorage.setItem(CURRENT_USER_KEY, this.currentUser.id);
      localStorage.setItem(DESKTOP_STATE_KEY, JSON.stringify(this.desktopStates));
    } catch (error) {
      console.error('Failed to save account state in localStorage:', error);
    }
  }

  private persistState(): Promise<boolean> {
    this.saveLocalState();
    return this.queueRemoteSave();
  }

  public getSyncStatus(): { state: AccountSyncState; error: string | null } {
    return { state: this.syncState, error: this.syncError };
  }

  private setSyncState(state: AccountSyncState, error: string | null = null): void {
    this.syncState = state;
    this.syncError = error;
    this.notify();
  }

  private queueRemoteSave(): Promise<boolean> {
    const body = JSON.stringify(this.createStoredState());
    if (new TextEncoder().encode(body).byteLength > MAX_ACCOUNT_STATE_BYTES) {
      this.setSyncState('offline', 'Account state exceeds the 2 MiB device limit.');
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      this.remoteSaveWaiters.push(resolve);
      this.remoteSavePending = true;
      void this.flushRemoteSaveQueue();
    });
  }

  private async flushRemoteSaveQueue(): Promise<void> {
    if (this.remoteSaveRunning) return;
    this.remoteSaveRunning = true;
    try {
      while (this.remoteSavePending) {
        this.remoteSavePending = false;
        const waiters = this.remoteSaveWaiters.splice(0);
        const body = JSON.stringify(this.createStoredState());
        if (new TextEncoder().encode(body).byteLength > MAX_ACCOUNT_STATE_BYTES) {
          this.setSyncState('offline', 'Account state exceeds the 2 MiB device limit.');
          waiters.forEach((resolve) => resolve(false));
          continue;
        }
        try {
          const response = await fetch(ACCOUNT_STATE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
          if (response.status !== 204) {
            throw new Error(`Device account-state save failed with HTTP ${response.status}.`);
          }
          this.setSyncState('connected');
          waiters.forEach((resolve) => resolve(true));
        } catch (error) {
          this.remoteSavePending = false;
          waiters.forEach((resolve) => resolve(false));
          this.remoteSaveWaiters.splice(0).forEach((resolve) => resolve(false));
          const message = error instanceof Error ? error.message : 'Unknown device synchronization error.';
          this.setSyncState('offline', message);
          console.error('Could not persist account state to the ESP32:', error);
        }
      }
    } finally {
      this.remoteSaveRunning = false;
      if (this.remoteSavePending) {
        void this.flushRemoteSaveQueue();
      }
    }
  }

  private loadCurrentUser(): UserProfile {
    try {
      const storedId = localStorage.getItem(CURRENT_USER_KEY);
      if (storedId) {
        const found = this.users.find(u => u.id === storedId);
        if (found) return found;
      }
    } catch (e) {
      console.warn('Failed to load current user:', e);
    }
    return this.users[1] || this.users[0] || DEFAULT_USERS[1];
  }

  public getUsers(): UserProfile[] {
    return [...this.users];
  }

  public getCurrentUser(): UserProfile {
    // Return latest reference of current user
    const found = this.currentUser
      ? this.users.find(u => u.id === this.currentUser.id)
      : undefined;
    if (found) {
      this.currentUser = found;
    } else {
      this.currentUser = this.users[1] || this.users[0] || DEFAULT_USERS[1];
    }
    return this.currentUser;
  }

  public getDesktopState(userId: string): AccountDesktopState | undefined {
    const state = this.desktopStates[userId];
    return state ? {
      ...state,
      windows: state.windows?.map((window) => ({ ...window })),
      office: state.office ? {
        ...state.office,
        grid: state.office.grid.map((row) => [...row]),
        slides: state.office.slides.map((slide) => ({ ...slide })),
      } : undefined,
    } : undefined;
  }

  public updateDesktopState(userId: string, state: AccountDesktopState): Promise<boolean> {
    if (!this.users.some((user) => user.id === userId)) {
      console.error(`Cannot persist desktop state for unknown account "${userId}".`);
      return Promise.resolve(false);
    }
    const current = this.desktopStates[userId] ?? {};
    this.desktopStates[userId] = {
      ...current,
      ...state,
      windows: state.windows?.map((window) => ({ ...window })) ?? current.windows,
      office: state.office ? {
        ...state.office,
        grid: state.office.grid.map((row) => [...row]),
        slides: state.office.slides.map((slide) => ({ ...slide })),
      } : current.office,
    };
    return this.persistState();
  }

  public async login(username: string, passwordPlain: string): Promise<{ success: boolean; message: string }> {
    const user = this.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) {
      return { success: false, message: 'The user account could not be found.' };
    }

    if (!user.hasPassword) {
      this.currentUser = user;
      this.persistState();
      this.notify();
      return { success: true, message: 'Logged in successfully.' };
    }

    const hashed = await hashPassword(passwordPlain);
    if (hashed === user.passwordHash) {
      this.currentUser = user;
      this.persistState();
      this.notify();
      return { success: true, message: 'Logged in successfully.' };
    }

    return { success: false, message: 'The password is incorrect. Please try again.' };
  }

  public logout(): void {
    this.currentUser = this.users[2] || this.users[0];
    this.persistState();
    this.notify();
  }

  public async verifyAdminPassword(passwordPlain: string): Promise<boolean> {
    const hashed = await hashPassword(passwordPlain);
    const admins = this.users.filter(u => u.isAdmin);
    for (const admin of admins) {
      if (!admin.hasPassword || admin.passwordHash === hashed) {
        return true;
      }
    }
    return false;
  }

  public async createUser(username: string, displayName: string, passwordPlain: string, isAdmin: boolean, avatarUrl?: string): Promise<UserProfile> {
    const hashed = passwordPlain ? await hashPassword(passwordPlain) : '';
    const newUser: UserProfile = {
      id: 'user_' + Date.now(),
      username,
      displayName: displayName || username,
      avatar: avatarUrl || PRESET_AVATARS[0].url,
      isAdmin,
      hasPassword: Boolean(passwordPlain),
      passwordHash: hashed,
      uacLevel: isAdmin ? 2 : 3,
      createdDate: new Date().toISOString().slice(0, 10),
    };

    this.users.push(newUser);
    this.saveUsers();
    return newUser;
  }

  public async updateProfile(
    userId: string,
    updates: {
      displayName?: string;
      username?: string;
      avatar?: string;
      passwordPlain?: string;
      removePassword?: boolean;
      isAdmin?: boolean;
      uacLevel?: number;
    }
  ): Promise<UserProfile | null> {
    const user = this.users.find(u => u.id === userId);
    if (!user) return null;

    if (updates.displayName !== undefined && updates.displayName.trim()) {
      user.displayName = updates.displayName.trim();
    }

    if (updates.username !== undefined && updates.username.trim()) {
      user.username = updates.username.trim();
    }

    if (updates.avatar !== undefined && updates.avatar.trim()) {
      user.avatar = updates.avatar.trim();
    }

    if (updates.isAdmin !== undefined) {
      user.isAdmin = updates.isAdmin;
    }

    if (updates.uacLevel !== undefined) {
      user.uacLevel = updates.uacLevel;
    }

    if (updates.removePassword) {
      user.hasPassword = false;
      user.passwordHash = '';
    } else if (updates.passwordPlain !== undefined && updates.passwordPlain.length > 0) {
      user.hasPassword = true;
      user.passwordHash = await hashPassword(updates.passwordPlain);
    }

    // If updating current user, refresh current user reference
    if (this.currentUser.id === userId) {
      this.currentUser = { ...user };
    }

    this.saveUsers();
    return user;
  }

  public deleteUser(userId: string): { success: boolean; message: string } {
    if (this.users.length <= 1) {
      return { success: false, message: 'Cannot delete the only remaining account.' };
    }

    const target = this.users.find(u => u.id === userId);
    if (!target) return { success: false, message: 'User not found.' };

    const remainingAdmins = this.users.filter(u => u.id !== userId && u.isAdmin);
    if (target.isAdmin && remainingAdmins.length === 0) {
      return { success: false, message: 'Cannot delete the only administrator account.' };
    }

    this.users = this.users.filter(u => u.id !== userId);
    delete this.desktopStates[userId];
    if (this.currentUser.id === userId) {
      this.currentUser = this.users[0];
    }

    this.saveUsers();
    return { success: true, message: `Account "${target.displayName}" deleted.` };
  }

  public updateUacLevel(userId: string, level: number): void {
    const user = this.users.find(u => u.id === userId);
    if (user) {
      user.uacLevel = level;
      if (this.currentUser.id === userId) {
        this.currentUser.uacLevel = level;
      }
      this.saveUsers();
    }
  }

  public subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  }

  public resetToDefault(): void {
    this.users = JSON.parse(JSON.stringify(DEFAULT_USERS));
    this.currentUser = this.users[1]; // Kennard
    this.desktopStates = {};
    this.saveUsers();
  }
}

export const authService = new AuthService();
