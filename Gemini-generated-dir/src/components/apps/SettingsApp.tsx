import React, { useState, useEffect } from 'react';
import bloomDarkWallpaper from '../../assets/images/win11_bloom_wallpaper_1791021193516.jpg';
import bloomLightWallpaper from '../../assets/images/win11_bloom_light_1791021745815.jpg';
import sunsetWallpaper from '../../assets/images/win11_sunset_glow_1791021759091.jpg';
import { 
  Laptop, 
  Users, 
  ShieldCheck, 
  Wifi, 
  Palette, 
  Plus, 
  KeyRound, 
  Check, 
  AlertCircle,
  HardDrive,
  Cpu,
  RotateCcw,
  Upload,
  Link as LinkIcon,
  Radio,
  RefreshCw,
  Globe,
  SlidersHorizontal,
  CheckCircle2,
  Lock as LockIcon,
  User,
  Edit3,
  Trash2,
  Shield,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Sparkles
} from 'lucide-react';
import { authService, PRESET_AVATARS, generateInitialsAvatar } from '../../services/authService';
import { virtualFs, UsbDiskInfo } from '../../services/virtualFs';
import { networkService, WifiNetwork, NetworkConfig } from '../../services/networkService';
import { UserProfile } from '../../types';

interface SettingsAppProps {
  currentWallpaper: string;
  onSelectWallpaper: (url: string) => void;
  onRequestUac: (appName: string, filePath: string, action: () => void) => void;
}

const PRESET_WALLPAPERS = [
  {
    id: 'bloom_dark',
    name: 'Windows 11 Bloom (Dark)',
    desc: 'Default Midnight & Azure Petals',
    url: bloomDarkWallpaper,
  },
  {
    id: 'bloom_light',
    name: 'Windows 11 Bloom (Light)',
    desc: 'Luminous Pearl White & Crystal Blue',
    url: bloomLightWallpaper,
  },
  {
    id: 'sunset_glow',
    name: 'Windows 11 Sunset Glow',
    desc: 'Twilight Amber & Violet Curves',
    url: sunsetWallpaper,
  },
  {
    id: 'fluent_flow',
    name: 'Fluent Flow (Electric)',
    desc: 'High Contrast Azure Waves',
    url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1920&q=80',
  },
  {
    id: 'slate_minimal',
    name: 'Midnight Slate Matrix',
    desc: 'Minimalist Dark Hardware Texture',
    url: 'https://images.unsplash.com/photo-1550684848-fac1c5b4e853?auto=format&fit=crop&w=1920&q=80',
  },
];

const MAX_USB_WALLPAPER_BYTES = 1024 * 1024;

export const SettingsApp: React.FC<SettingsAppProps> = ({
  currentWallpaper,
  onSelectWallpaper,
  onRequestUac,
}) => {
  const [activeSection, setActiveSection] = useState<'system' | 'accounts' | 'security' | 'network' | 'personalization'>('accounts');
  const [users, setUsers] = useState<UserProfile[]>(authService.getUsers());
  const [currentUser, setCurrentUser] = useState<UserProfile>(authService.getCurrentUser());
  const [accountSync, setAccountSync] = useState(authService.getSyncStatus());

  // Editing profile state
  const [editingUserId, setEditingUserId] = useState<string>(authService.getCurrentUser().id);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editUsername, setEditUsername] = useState('');
  const [editAvatar, setEditAvatar] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editPasswordConfirm, setEditPasswordConfirm] = useState('');
  const [passwordMismatchError, setPasswordMismatchError] = useState('');
  const [deviceAdminPassword, setDeviceAdminPassword] = useState('');
  const [editRemovePassword, setEditRemovePassword] = useState(false);
  const [editIsAdmin, setEditIsAdmin] = useState(false);
  const [showPasswordInput, setShowPasswordInput] = useState(false);
  const [avatarUrlInput, setAvatarUrlInput] = useState('');
  const [profileNotice, setProfileNotice] = useState<string | null>(null);

  // USB Auto-detection state
  const [usbDisk, setUsbDisk] = useState<UsbDiskInfo>(virtualFs.getUsbDiskInfo());
  const [isDetectingDisk, setIsDetectingDisk] = useState(false);
  const [diskNotice, setDiskNotice] = useState<string | null>(null);

  // Network state
  const [netConfig, setNetConfig] = useState<NetworkConfig>(networkService.getConfig());
  const [availableNetworks, setAvailableNetworks] = useState<WifiNetwork[]>([]);
  const [isScanningWifi, setIsScanningWifi] = useState(false);
  const [selectedSsid, setSelectedSsid] = useState('');
  const [homePasswordInput, setHomePasswordInput] = useState('');
  const [isConnectingWifi, setIsConnectingWifi] = useState(false);
  const [wifiNotice, setWifiNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Custom Wallpaper state
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [wallpaperNotice, setWallpaperNotice] = useState<string | null>(null);
  const [recentWallpapers, setRecentWallpapers] = useState<string[]>([currentWallpaper]);

  // New user form state
  const [isAddingUser, setIsAddingUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newAvatar, setNewAvatar] = useState(PRESET_AVATARS[0].url);
  const [newIsAdmin, setNewIsAdmin] = useState(false);

  // UAC Level
  const [uacLevel, setUacLevel] = useState(currentUser.uacLevel);
  const [uacSaved, setUacSaved] = useState(false);

  // Sync with authService and virtualFs
  useEffect(() => {
    const unsubAuth = authService.subscribe(() => {
      const all = authService.getUsers();
      setUsers(all);
      const curr = authService.getCurrentUser();
      setCurrentUser(curr);
      setAccountSync(authService.getSyncStatus());
    });

    const unsubFs = virtualFs.subscribe(() => {
      setUsbDisk(virtualFs.getUsbDiskInfo());
    });

    const unsubNet = networkService.subscribe((cfg) => setNetConfig(cfg));

    loadEditingUser(authService.getCurrentUser().id);
    handleScanWifi();

    return () => {
      unsubAuth();
      unsubFs();
      unsubNet();
    };
  }, []);

  const loadEditingUser = (userId: string) => {
    const target = authService.getUsers().find(u => u.id === userId) || authService.getCurrentUser();
    setEditingUserId(target.id);
    setEditDisplayName(target.displayName);
    setEditUsername(target.username);
    setEditAvatar(target.avatar);
    setEditIsAdmin(target.isAdmin);
    setEditPassword('');
    setEditPasswordConfirm('');
    setPasswordMismatchError('');
    setEditRemovePassword(!target.hasPassword);
    setAvatarUrlInput('');
  };

  const handleGenerateInitials = (color: string = '#2563eb') => {
    const name = editDisplayName.trim() || editUsername.trim() || 'User';
    const newAvatar = generateInitialsAvatar(name, color);
    setEditAvatar(newAvatar);
    setProfileNotice(`Generated initials avatar for "${name}". Click "Save Profile Changes" to apply.`);
    setTimeout(() => setProfileNotice(null), 3000);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMismatchError('');
    if (!editDisplayName.trim() || !editUsername.trim()) return;

    // Password validation
    if (!editRemovePassword && editPassword) {
      if (editPassword !== editPasswordConfirm) {
        setPasswordMismatchError('Passwords do not match. Please verify your new password confirmation.');
        return;
      }
      if (editPassword.length < 8) {
        setPasswordMismatchError('Use at least 8 characters for the new password.');
        return;
      }
    }

    onRequestUac('Update User Profile', `D:\\System\\users.db - Set credentials for ${editUsername}`, async () => {
      const editingUser = users.find((user) => user.id === editingUserId);
      if (editingUser?.isAdmin && editPassword) {
        if (!deviceAdminPassword) {
          setPasswordMismatchError('Enter the current device administrator password to sync firmware credentials.');
          return;
        }
        const passwordResponse = await fetch('/api/auth/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: editingUser.username,
            current_password: deviceAdminPassword,
            new_password: editPassword,
          }),
        });
        if (!passwordResponse.ok) {
          setPasswordMismatchError(await passwordResponse.text());
          return;
        }
      }

      const updated = await authService.updateProfile(editingUserId, {
        displayName: editDisplayName.trim(),
        username: editUsername.trim(),
        avatar: editAvatar.trim(),
        passwordPlain: editRemovePassword ? '' : editPassword,
        removePassword: editRemovePassword,
        isAdmin: editIsAdmin,
      });

      if (updated) {
        setUsers(authService.getUsers());
        setCurrentUser(authService.getCurrentUser());
        setEditPassword('');
        setEditPasswordConfirm('');
        setDeviceAdminPassword('');
        setPasswordMismatchError('');
        setProfileNotice(`Profile "${updated.displayName}" updated successfully and saved to USB.`);
        setTimeout(() => setProfileNotice(null), 3500);

        // Also commit to USB Virtual FS
        virtualFs.createFile('D:\\System', 'users.json', JSON.stringify(authService.getUsers(), null, 2));
      }
    });
  };

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      if (dataUrl) {
        setEditAvatar(dataUrl);
        // Persist file into user's USB pictures directory
        virtualFs.createFolder(`D:\\Users\\${editUsername}`, 'Pictures');
        virtualFs.createFolder(`D:\\Users\\${editUsername}\\Pictures`, 'Avatars');
        virtualFs.createFile(`D:\\Users\\${editUsername}\\Pictures\\Avatars`, file.name, `[Avatar Image: ${file.size} bytes]`);
        setProfileNotice(`Loaded profile picture "${file.name}". Click "Save Profile Changes" to apply.`);
        setTimeout(() => setProfileNotice(null), 3000);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleDeleteUser = (userId: string) => {
    onRequestUac('Delete User Account', `net.exe user ${userId} /delete`, () => {
      const res = authService.deleteUser(userId);
      if (res.success) {
        setUsers(authService.getUsers());
        setCurrentUser(authService.getCurrentUser());
        loadEditingUser(authService.getCurrentUser().id);
        setProfileNotice(res.message);
        setTimeout(() => setProfileNotice(null), 3000);
      } else {
        alert(res.message);
      }
    });
  };

  const handleAutoDetectDisk = async () => {
    setIsDetectingDisk(true);
    setDiskNotice(null);
    try {
      const detected = await virtualFs.autoDetectDisk();
      setUsbDisk(detected);
      setDiskNotice(detected.status === 'ONLINE'
        ? `Detected ${detected.vendor} ${detected.model} (${detected.vendorId}:${detected.productId}, ${detected.capacityGb.toFixed(2)} GiB, ${detected.totalSectors.toLocaleString()} sectors).`
        : 'USB detection failed: no mass-storage drive is currently mounted on the ESP32.');
      setTimeout(() => setDiskNotice(null), 4000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDiskNotice(`USB detection failed: ${message}`);
    } finally {
      setIsDetectingDisk(false);
    }
  };

  const handleScanWifi = async () => {
    setIsScanningWifi(true);
    const nets = await networkService.scanNetworks();
    setAvailableNetworks(nets);
    setIsScanningWifi(false);
  };

  const handleConnectHomeWifi = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const ssid = selectedSsid.trim();
    if (!ssid) return;

    setIsConnectingWifi(true);
    setWifiNotice(null);

    const res = await networkService.connectToHomeNetwork(ssid, homePasswordInput);
    setIsConnectingWifi(false);

    if (res.success) {
      setWifiNotice({ type: 'success', text: res.message });
      virtualFs.createFile('D:\\System', 'wifi_config.json', JSON.stringify({
        homeSsid: ssid,
        connected: true,
        ipAddress: networkService.getConfig().ipAddress,
        mode: 'APSTA',
        timestamp: new Date().toISOString()
      }, null, 2));
    } else {
      setWifiNotice({ type: 'error', text: res.message });
    }
  };

  const handleDisconnectHomeWifi = () => {
    networkService.disconnectHomeNetwork();
    setWifiNotice({ type: 'success', text: 'Disconnected from Home Wi-Fi. System operating in SoftAP fallback mode.' });
  };

  const persistWallpaperToUsb = async (image: Blob, profileName: string) => {
    if (image.size > MAX_USB_WALLPAPER_BYTES) throw new Error('Choose a wallpaper no larger than 1 MiB.');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type)) {
      throw new Error('Use a JPEG, PNG, or WebP image.');
    }
    const password = window.prompt('Enter the device administrator password to save this wallpaper to USB.');
    if (!password) throw new Error('Administrator password required to write the USB drive.');
    const response = await fetch('/api/profiles/current/wallpaper', {
      method: 'POST',
      headers: {
        'Content-Type': image.type,
        'X-Admin-Password': password,
        'X-Profile-Name': profileName,
      },
      body: image,
    });
    if (!response.ok) throw new Error(await response.text());
  };

  const getUsbWallpaperUrl = (profileName: string) =>
    `/api/profiles/current/wallpaper?profile=${encodeURIComponent(profileName)}`;

  const handleSelectPresetWallpaper = async (url: string, name: string) => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Wallpaper asset could not be read.');
      const image = await response.blob();
      const profileName = currentUser.username.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 31) || 'User';
      await persistWallpaperToUsb(image, profileName);
      const usbUrl = getUsbWallpaperUrl(profileName);
      onSelectWallpaper(usbUrl);
      setWallpaperNotice(`Saved "${name}" to this profile on USB.`);
    } catch (error) {
      setWallpaperNotice(error instanceof Error ? error.message : 'Could not save wallpaper to USB.');
    }
    setTimeout(() => setWallpaperNotice(null), 3000);
  };

  const handleApplyCustomUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customUrlInput.trim()) return;
    const url = customUrlInput.trim();
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Image could not be downloaded for USB storage.');
      const image = await response.blob();
      const profileName = currentUser.username.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 31) || 'User';
      await persistWallpaperToUsb(image, profileName);
      const usbUrl = getUsbWallpaperUrl(profileName);
      onSelectWallpaper(usbUrl);
      if (!recentWallpapers.includes(usbUrl)) setRecentWallpapers([usbUrl, ...recentWallpapers.slice(0, 4)]);
      setWallpaperNotice('Wallpaper saved to this profile on the USB drive.');
    } catch (error) {
      setWallpaperNotice(error instanceof Error ? error.message : 'Could not save this wallpaper to USB.');
    }
    setTimeout(() => setWallpaperNotice(null), 3000);
  };

  const handleUploadWallpaper = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_USB_WALLPAPER_BYTES) {
      setWallpaperNotice('Image is too large. Choose an image no larger than 1 MiB.');
      e.target.value = '';
      return;
    }

    try {
      const profileName = currentUser.username.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 31) || 'User';
      await persistWallpaperToUsb(file, profileName);
      const usbUrl = getUsbWallpaperUrl(profileName);
      onSelectWallpaper(usbUrl);
      if (!recentWallpapers.includes(usbUrl)) {
        setRecentWallpapers([usbUrl, ...recentWallpapers.slice(0, 4)]);
      }
      setWallpaperNotice(`Saved "${file.name}" to this profile on USB.`);
      setTimeout(() => setWallpaperNotice(null), 3500);
    } catch (error) {
      setWallpaperNotice(error instanceof Error ? error.message : 'Could not save wallpaper to USB.');
    }
    e.target.value = '';
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim()) return;

    onRequestUac('Add User Account', 'C:\\Windows\\System32\\net.exe user /add', async () => {
      await authService.createUser(newUsername.trim(), newDisplayName.trim(), newPassword, newIsAdmin, newAvatar);
      setUsers(authService.getUsers());
      setIsAddingUser(false);
      setNewUsername('');
      setNewDisplayName('');
      setNewPassword('');
      setNewAvatar(PRESET_AVATARS[0].url);
      setProfileNotice(`User profile "${newDisplayName || newUsername}" created successfully!`);
      setTimeout(() => setProfileNotice(null), 3500);
    });
  };

  const handleUpdateUac = (newLevel: number) => {
    onRequestUac('Change User Account Control Settings', 'C:\\Windows\\System32\\UserAccountControlSettings.exe', () => {
      setUacLevel(newLevel);
      authService.updateUacLevel(currentUser.id, newLevel);
      setUacSaved(true);
      setTimeout(() => setUacSaved(false), 2000);
    });
  };

  const handleResetStorage = () => {
    onRequestUac('Format and Reset Virtual Storage', 'C:\\Windows\\System32\\format.com D:', () => {
      virtualFs.resetToFactory();
      authService.resetToDefault();
      setUsers(authService.getUsers());
      alert('Virtual storage and user accounts reset to default ESP32-S3 state.');
    });
  };

  return (
    <div className="flex h-full bg-[#181d28] text-slate-100 select-none">
      {/* Settings Navigation Sidebar */}
      <div className="w-60 border-r border-neutral-800 bg-[#141822] p-3 space-y-1 shrink-0 overflow-y-auto">
        <div className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">
          Settings
        </div>

        <button
          type="button"
          onClick={() => setActiveSection('accounts')}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
            activeSection === 'accounts' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/5'
          }`}
        >
          <Users className="w-4 h-4 text-amber-300" />
          <span>Accounts & Passwords</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveSection('system')}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
            activeSection === 'system' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/5'
          }`}
        >
          <HardDrive className="w-4 h-4 text-blue-300" />
          <span>System & Auto-Detect USB</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveSection('personalization')}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
            activeSection === 'personalization' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/5'
          }`}
        >
          <Palette className="w-4 h-4 text-purple-300" />
          <span>Personalization & Wallpaper</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveSection('network')}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
            activeSection === 'network' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/5'
          }`}
        >
          <Wifi className="w-4 h-4 text-cyan-300" />
          <span>Home Network & Wi-Fi</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveSection('security')}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
            activeSection === 'security' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/5'
          }`}
        >
          <ShieldCheck className="w-4 h-4 text-emerald-300" />
          <span>UAC & Security</span>
        </button>
      </div>

      {/* Main Settings Content */}
      <div className="flex-1 p-6 overflow-y-auto">
        {/* Section: Accounts & Passwords */}
        {activeSection === 'accounts' && (
          <div className="max-w-3xl space-y-6">
            <div className="flex justify-between items-start">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <Users className="w-5 h-5 text-amber-400" />
                  <span>Customize User Profiles & Passwords</span>
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Change profile pictures, names, passwords, and administrative rights. Shared account and desktop state is stored by the ESP32 and used by every device connecting to it.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsAddingUser(!isAddingUser)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors shadow"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Account</span>
              </button>
            </div>

            <div className={`flex items-center justify-between gap-3 rounded-xl border p-3 text-xs ${
              accountSync.state === 'connected'
                ? 'border-emerald-800 bg-emerald-950/40 text-emerald-200'
                : accountSync.state === 'loading'
                  ? 'border-blue-800 bg-blue-950/40 text-blue-200'
                  : 'border-amber-800 bg-amber-950/40 text-amber-200'
            }`}>
              <span>
                {accountSync.state === 'connected'
                  ? 'Account sync connected to the ESP32.'
                  : accountSync.state === 'loading'
                    ? 'Connecting to shared ESP32 account storage…'
                    : `Account sync unavailable; changes may remain local. ${accountSync.error ?? ''}`}
              </span>
              {accountSync.state === 'offline' && (
                <button
                  type="button"
                  onClick={() => void authService.initialize()}
                  className="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 font-semibold hover:bg-white/20"
                >
                  Retry sync
                </button>
              )}
            </div>

            {profileNotice && (
              <div className="p-3 bg-emerald-950/60 border border-emerald-800 text-emerald-300 rounded-xl text-xs flex items-center gap-2 animate-in fade-in duration-200">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{profileNotice}</span>
              </div>
            )}

            {/* Quick User Selector Carousel */}
            <div className="p-4 bg-[#1f2533] rounded-2xl border border-neutral-700/60 space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Select Profile to Customize
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {users.map((u) => {
                  const isSelected = editingUserId === u.id;
                  const isCurrent = currentUser.id === u.id;
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => loadEditingUser(u.id)}
                      className={`p-3 rounded-xl border text-left flex items-center gap-3 transition-all ${
                        isSelected
                          ? 'bg-blue-600/20 border-blue-500 ring-2 ring-blue-500/30'
                          : 'bg-neutral-900/60 border-neutral-800 hover:bg-white/5'
                      }`}
                    >
                      <div className="relative">
                        <img src={u.avatar} alt="" className="w-10 h-10 rounded-full object-cover ring-2 ring-white/10 shrink-0" />
                        {u.isAdmin && (
                          <div className="absolute -bottom-1 -right-1 bg-amber-500 rounded-full p-0.5 border border-black shadow">
                            <Shield className="w-2.5 h-2.5 text-black" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-white truncate flex items-center gap-1.5">
                          <span>{u.displayName}</span>
                          {isCurrent && (
                            <span className="text-[9px] bg-blue-500/30 text-blue-300 px-1 py-0.2 rounded font-mono">
                              You
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 truncate">
                          @{u.username} · {u.hasPassword ? 'Password' : 'No Pass'}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Profile Customization Form */}
            <form onSubmit={handleSaveProfile} className="p-5 bg-[#1f2533] rounded-2xl border border-neutral-700/60 space-y-6">
              <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
                <div className="text-sm font-bold text-white flex items-center gap-2">
                  <Edit3 className="w-4 h-4 text-blue-400" />
                  <span>Editing Profile: {editDisplayName || editUsername}</span>
                </div>
                {users.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleDeleteUser(editingUserId)}
                    className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Account</span>
                  </button>
                )}
              </div>

              {/* 1. Profile Picture Customization */}
              <div className="space-y-3">
                <label className="block text-xs font-semibold text-slate-300">
                  Profile Picture
                </label>

                <div className="flex flex-col sm:flex-row items-center gap-4">
                  {/* Current Avatar preview */}
                  <div className="w-20 h-20 rounded-full overflow-hidden ring-4 ring-blue-500/30 shadow-xl bg-neutral-900 shrink-0">
                    <img src={editAvatar} alt="" className="w-full h-full object-cover" />
                  </div>

                  <div className="flex-1 space-y-2 w-full">
                    {/* Upload from PC */}
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs font-medium cursor-pointer transition-colors shadow">
                        <Upload className="w-3.5 h-3.5" />
                        <span>Upload Picture from Computer</span>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleAvatarUpload}
                          className="hidden"
                        />
                      </label>

                      {/* Or enter custom image URL */}
                      <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                        <input
                          type="url"
                          placeholder="Or paste image URL..."
                          value={avatarUrlInput}
                          onChange={(e) => setAvatarUrlInput(e.target.value)}
                          className="flex-1 px-3 py-1.5 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (avatarUrlInput.trim()) {
                              setEditAvatar(avatarUrlInput.trim());
                              setAvatarUrlInput('');
                            }
                          }}
                          className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-slate-200 rounded-lg text-xs"
                        >
                          Apply URL
                        </button>
                      </div>
                    </div>

                    {/* Preset Avatars Carousel & Initials Generator */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-slate-400">Choose a preset avatar or generate with initials:</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-slate-400">Generate Initials:</span>
                          {[
                            { color: '#2563eb', label: 'Blue' },
                            { color: '#059669', label: 'Emerald' },
                            { color: '#7c3aed', label: 'Violet' },
                            { color: '#d97706', label: 'Amber' },
                            { color: '#e11d48', label: 'Rose' },
                          ].map((c) => (
                            <button
                              key={c.color}
                              type="button"
                              onClick={() => handleGenerateInitials(c.color)}
                              className="w-4 h-4 rounded-full border border-white/20 transition-transform hover:scale-125"
                              style={{ backgroundColor: c.color }}
                              title={`Generate ${c.label} Initials Avatar`}
                            />
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 overflow-x-auto pb-1">
                        {PRESET_AVATARS.map((av) => (
                          <button
                            key={av.id}
                            type="button"
                            onClick={() => setEditAvatar(av.url)}
                            className={`w-9 h-9 rounded-full overflow-hidden border shrink-0 transition-all ${
                              editAvatar === av.url ? 'border-blue-500 ring-2 ring-blue-500/40 scale-105' : 'border-neutral-700 opacity-75 hover:opacity-100'
                            }`}
                            title={av.name}
                          >
                            <img src={av.url} alt={av.name} className="w-full h-full object-cover" />
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 2. Names Customization */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-neutral-800">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={editDisplayName}
                    onChange={(e) => setEditDisplayName(e.target.value)}
                    required
                    placeholder="e.g. Kennard Devida"
                    className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-[10px] text-slate-500">Visible on the Lock Screen, Start Menu, and Taskbar</span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    System Username
                  </label>
                  <input
                    type="text"
                    value={editUsername}
                    onChange={(e) => setEditUsername(e.target.value)}
                    required
                    placeholder="e.g. kennard"
                    className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
                  />
                  <span className="text-[10px] text-slate-500">Maps to user folder on 32GB USB: <code className="text-amber-300">D:\Users\{editUsername}\</code></span>
                </div>
              </div>

              {/* 3. Password Management */}
              <div className="p-4 bg-neutral-900/80 rounded-xl border border-neutral-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-amber-400" />
                    <span className="text-xs font-semibold text-white">Password & Sign-In Options</span>
                  </div>

                  <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editRemovePassword}
                      onChange={(e) => setEditRemovePassword(e.target.checked)}
                      className="rounded accent-blue-600"
                    />
                    <span>Sign in without password (No Password)</span>
                  </label>
                </div>

                {!editRemovePassword && (
                  <div className="space-y-3 pt-1">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">
                          New Password (leave empty to keep current):
                        </label>
                        <div className="relative">
                          <input
                            type={showPasswordInput ? 'text' : 'password'}
                            placeholder="Enter new password"
                            value={editPassword}
                            onChange={(e) => {
                              setEditPassword(e.target.value);
                              setPasswordMismatchError('');
                            }}
                            className="w-full px-3 py-2 pr-10 bg-neutral-950 border border-neutral-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPasswordInput(!showPasswordInput)}
                            className="absolute right-3 top-2 text-slate-400 hover:text-white"
                          >
                            {showPasswordInput ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>

                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">
                          Confirm New Password:
                        </label>
                        <input
                          type={showPasswordInput ? 'text' : 'password'}
                          placeholder="Re-enter new password"
                          value={editPasswordConfirm}
                          onChange={(e) => {
                            setEditPasswordConfirm(e.target.value);
                            setPasswordMismatchError('');
                          }}
                          disabled={!editPassword}
                          className="w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 disabled:opacity-40"
                        />
                      </div>
                    </div>

                    {editIsAdmin && editPassword && users.find((user) => user.id === editingUserId)?.isAdmin && (
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Current device administrator password (firmware)</label>
                        <input
                          type="password"
                          value={deviceAdminPassword}
                          onChange={(event) => setDeviceAdminPassword(event.target.value)}
                          autoComplete="current-password"
                          className="w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                        />
                      </div>
                    )}

                    {passwordMismatchError && (
                      <p className="text-xs text-red-400 font-medium bg-red-950/40 p-2 rounded border border-red-800/50">
                        {passwordMismatchError}
                      </p>
                    )}

                    <span className="block text-[10px] text-slate-500">
                      Passwords are stored as SHA-256 hashes; firmware administrator changes are written to the USB account database.
                    </span>
                  </div>
                )}
              </div>

              {/* 4. Administrator Rights */}
              <div className="flex items-center justify-between p-3.5 bg-neutral-900/50 rounded-xl border border-neutral-800">
                <div>
                  <div className="text-xs font-semibold text-white">Administrator Privileges</div>
                  <div className="text-[11px] text-slate-400">
                    Allows running privileged .exe apps, managing UAC, and modifying system partitions.
                  </div>
                </div>

                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editIsAdmin}
                    onChange={(e) => setEditIsAdmin(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-neutral-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600" />
                </label>
              </div>

              {/* Submit Button */}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="submit"
                  className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white rounded-xl text-xs font-medium transition-colors shadow-lg"
                >
                  <Check className="w-4 h-4" />
                  <span>Save Profile Changes</span>
                </button>
              </div>
            </form>

            {/* Add User Modal / Form */}
            {isAddingUser && (
              <form onSubmit={handleAddUser} className="p-5 bg-[#141824] rounded-2xl border border-blue-500/50 space-y-4">
                <div className="text-sm font-bold text-white flex items-center gap-2">
                  <Plus className="w-4 h-4 text-emerald-400" />
                  <span>Create New Windows 11 Profile</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="text"
                    placeholder="Display Name (e.g. Alex Rivera)"
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                    required
                    className="px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="text"
                    placeholder="Username (e.g. alex)"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    required
                    className="px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>

                <input
                  type="password"
                  placeholder="Password (leave blank for no password)"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />

                <div className="space-y-1.5">
                  <label className="block text-[11px] text-slate-400">Select Profile Picture:</label>
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    {PRESET_AVATARS.map((av) => (
                      <button
                        key={av.id}
                        type="button"
                        onClick={() => setNewAvatar(av.url)}
                        className={`w-8 h-8 rounded-full overflow-hidden border shrink-0 transition-all ${
                          newAvatar === av.url ? 'border-blue-500 ring-2 ring-blue-500/50 scale-105' : 'border-neutral-700 opacity-70 hover:opacity-100'
                        }`}
                        title={av.name}
                      >
                        <img src={av.url} alt={av.name} className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newIsAdmin}
                    onChange={(e) => setNewIsAdmin(e.target.checked)}
                    className="rounded accent-blue-600"
                  />
                  <span>Grant Administrator Privileges</span>
                </label>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsAddingUser(false)}
                    className="px-3 py-1.5 bg-neutral-800 text-slate-300 rounded text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium"
                  >
                    Create User
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* Section: System & Auto-Detect Flash Drive */}
        {activeSection === 'system' && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <HardDrive className="w-5 h-5 text-blue-400" />
                <span>System & USB Flash Drive Auto-Detection</span>
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Hardware specifications for ESP32-S3 N16R8 and real-time SCSI interrogation of the USB-OTG flash drive.
              </p>
            </div>

            {diskNotice && (
              <div className={`p-3 rounded-xl text-xs flex items-center gap-2 animate-in fade-in duration-200 ${
                diskNotice.startsWith('USB detection failed:')
                  ? 'bg-red-950/60 border border-red-800 text-red-300'
                  : 'bg-blue-950/60 border border-blue-800 text-blue-300'
              }`}>
                {diskNotice.startsWith('USB detection failed:')
                  ? <AlertCircle className="w-4 h-4 shrink-0" />
                  : <CheckCircle2 className="w-4 h-4 shrink-0" />}
                <span>{diskNotice}</span>
              </div>
            )}

            {/* USB-OTG Auto-Detection Card */}
            <div className="p-5 bg-[#1f2533] rounded-2xl border border-neutral-700/60 space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
                <div className="flex items-center gap-3">
                  <div className={`w-3.5 h-3.5 rounded-full ${
                    usbDisk.status === 'SCANNING'
                      ? 'bg-amber-400 animate-ping'
                      : usbDisk.status === 'ONLINE'
                        ? 'bg-emerald-400 animate-pulse'
                        : 'bg-red-400'
                  }`} />
                  <div>
                    <div className="text-sm font-semibold text-white flex items-center gap-2">
                      <span>Drive D: {usbDisk.vendor} {usbDisk.model}</span>
                      <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded font-mono border border-emerald-500/30">
                        {usbDisk.status === 'ONLINE' ? `${usbDisk.capacityGb.toFixed(2)} GiB Detected` : usbDisk.status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {usbDisk.status === 'ONLINE'
                        ? <>Mounted at <code className="text-amber-300 font-mono">/usb</code> via native ESP32-S3 USB Host MSC (GPIO 19/20)</>
                        : 'No USB mass-storage volume is currently mounted.'}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleAutoDetectDisk}
                  disabled={isDetectingDisk}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs font-medium transition-colors shadow disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isDetectingDisk ? 'animate-spin' : ''}`} />
                  <span>{isDetectingDisk ? 'Interrogating SCSI...' : 'Auto-Detect Flash Drive Size'}</span>
                </button>
              </div>

              {/* SCSI Inquiry & Geometry Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
                <div className="p-3 bg-neutral-900 rounded-xl border border-neutral-800">
                  <span className="text-slate-400 text-[10px] font-sans">Device Capacity:</span>
                  <div className="text-sm font-bold text-amber-300 mt-0.5 truncate">{usbDisk.capacityGb.toFixed(2)} GiB</div>
                  <div className="text-[10px] text-slate-500 mt-0.5 font-mono">{usbDisk.capacityBytes.toLocaleString()} B</div>
                  <div className="text-[10px] text-slate-400 mt-1">
                    Filesystem used: {usbDisk.usedBytes === null ? 'Unavailable' : `${(usbDisk.usedBytes / (1024 ** 3)).toFixed(2)} GiB`}
                  {' · '}free: {usbDisk.filesystemFreeBytes === null ? 'Unavailable' : `${(usbDisk.filesystemFreeBytes / (1024 ** 3)).toFixed(2)} GiB`}
                  </div>
                </div>

                <div className="p-3 bg-neutral-900 rounded-xl border border-neutral-800">
                  <span className="text-slate-400 text-[10px] font-sans">SCSI Sector Count:</span>
                  <div className="text-sm font-bold text-white mt-0.5 truncate">{usbDisk.totalSectors.toLocaleString()}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5 font-sans">{usbDisk.sectorSize.toLocaleString()} Bytes / Sector</div>
                </div>

                <div className="p-3 bg-neutral-900 rounded-xl border border-neutral-800">
                  <span className="text-slate-400 text-[10px] font-sans">USB VID:PID:</span>
                  <div className="text-sm font-bold text-cyan-300 mt-0.5 truncate">{usbDisk.vendorId}:{usbDisk.productId}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5 truncate">{usbDisk.vendor} {usbDisk.model}</div>
                </div>

                <div className="p-3 bg-neutral-900 rounded-xl border border-neutral-800">
                  <span className="text-slate-400 text-[10px] font-sans">Drive Serial Number:</span>
                  <div className="text-sm font-bold text-slate-200 mt-0.5 truncate">{usbDisk.serialNumber}</div>
                  <div className={`text-[10px] mt-0.5 font-sans ${usbDisk.status === 'ONLINE' ? 'text-emerald-400' : 'text-red-400'}`}>
                    Status: {usbDisk.status}
                  </div>
                </div>
              </div>

            </div>

            {/* Hardware Specs Card */}
            <div className="p-4 bg-[#1f2533] rounded-xl border border-neutral-700/60 space-y-3">
              <div className="flex items-center gap-3 pb-3 border-b border-neutral-800">
                <Cpu className="w-6 h-6 text-blue-400" />
                <div>
                  <div className="text-sm font-semibold text-white">ESP32-S3-WROOM-1-N16R8</div>
                  <div className="text-xs text-slate-400">Xtensa Dual-Core 32-bit LX7 @ 240 MHz</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-slate-400">Total Installed PSRAM:</span>
                  <div className="font-mono text-cyan-300 font-medium">8,192 KB (8MB Octal SPI 80MHz)</div>
                </div>
                <div>
                  <span className="text-slate-400">Internal SPI Flash:</span>
                  <div className="font-mono text-purple-300 font-medium">16 MB Quad SPI</div>
                </div>
                <div>
                  <span className="text-slate-400">USB Interface:</span>
                  <div className="font-mono text-amber-300 font-medium">Native USB 2.0 OTG Host</div>
                </div>
                <div>
                  <span className="text-slate-400">Primary External Storage:</span>
                  <div className="font-mono text-white font-medium">
                    {usbDisk.capacityGb.toFixed(2)} GiB ({usbDisk.vendorId}:{usbDisk.productId})
                  </div>
                </div>
              </div>
            </div>

            {/* Reset storage */}
            <div className="p-4 bg-[#1f2533] rounded-xl border border-neutral-700/60 flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-white">Reset USB File System & Defaults</div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  Restores initial Windows 11 folders, accounts, and demo executables.
                </div>
              </div>
              <button
                type="button"
                onClick={handleResetStorage}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-300 border border-red-500/30 text-xs font-medium transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset System</span>
              </button>
            </div>
          </div>
        )}

        {/* Section: Personalization */}
        {activeSection === 'personalization' && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Palette className="w-5 h-5 text-purple-400" />
                <span>Personalization & Custom Wallpapers</span>
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Set custom background pictures, upload images from your computer to the USB drive, or choose Windows 11 themes.
              </p>
            </div>

            {/* Active Wallpaper Preview Card */}
            <div className="p-4 bg-[#1f2533] rounded-2xl border border-neutral-700/60 flex flex-col md:flex-row gap-5 items-center">
              <div className="w-full md:w-56 h-32 rounded-xl overflow-hidden border border-neutral-700 bg-neutral-900 shrink-0 shadow-lg relative group">
                <img
                  src={currentWallpaper}
                  alt="Active Wallpaper"
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-[11px] text-white font-medium">
                  Active Background
                </div>
              </div>

              <div className="flex-1 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-purple-300">
                  Current Desktop & Lock Screen Background
                </div>
                <div className="text-xs font-mono text-slate-300 break-all bg-black/30 p-2 rounded border border-neutral-800">
                  {currentWallpaper}
                </div>
                <div className="text-[11px] text-slate-400">
                  Persisted with this account in USB-backed desktop settings; uploaded images are also stored in the account wallpaper folder.
                </div>
              </div>
            </div>

            {wallpaperNotice && (
              <div className="p-3 bg-emerald-950/60 border border-emerald-800 text-emerald-300 rounded-xl text-xs flex items-center gap-2 animate-in fade-in duration-200">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{wallpaperNotice}</span>
              </div>
            )}

            {/* Custom Wallpaper Actions (Upload & URL) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Option A: Upload from PC */}
              <div className="p-5 bg-[#1f2533] rounded-2xl border border-neutral-700/60 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Upload className="w-4 h-4 text-emerald-400" />
                  <span>Upload Image from Your PC</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Choose a JPEG, PNG, or WebP image up to 1 MiB. The image bytes are saved to this account's USB wallpaper folder before applying.
                </p>

                <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-xs font-medium cursor-pointer transition-colors shadow">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Choose Image File...</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleUploadWallpaper}
                    className="hidden"
                  />
                </label>
              </div>

              {/* Option B: Enter Web Image URL */}
              <div className="p-5 bg-[#1f2533] rounded-2xl border border-neutral-700/60 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <LinkIcon className="w-4 h-4 text-blue-400" />
                  <span>Custom Image Web URL</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Paste any direct online image URL (HTTP/HTTPS) to apply it as your wallpaper:
                </p>

                <form onSubmit={handleApplyCustomUrl} className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="url"
                      placeholder="https://example.com/wallpaper.jpg"
                      value={customUrlInput}
                      onChange={(e) => setCustomUrlInput(e.target.value)}
                      className="flex-1 px-3 py-1.5 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
                    />
                    <button
                      type="submit"
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition-colors"
                    >
                      Apply
                    </button>
                  </div>
                </form>
              </div>
            </div>

            {/* Built-in Windows 11 Curated Wallpapers */}
            <div className="p-5 bg-[#1f2533] rounded-2xl border border-neutral-700/60 space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Windows 11 Themes & Wallpapers
                </div>
                <span className="text-[11px] text-slate-400">Click any theme to apply immediately</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {PRESET_WALLPAPERS.map((wp) => {
                  const isActive = currentWallpaper === wp.url;
                  return (
                    <button
                      key={wp.id}
                      type="button"
                      onClick={() => void handleSelectPresetWallpaper(wp.url, wp.name)}
                      className={`p-2 rounded-xl border text-left transition-all group ${
                        isActive
                          ? 'border-blue-500 ring-2 ring-blue-500/40 bg-blue-600/10'
                          : 'border-neutral-700/80 bg-neutral-900/40 hover:border-neutral-600 hover:bg-white/5'
                      }`}
                    >
                      <div className="relative h-28 rounded-lg overflow-hidden mb-2 bg-neutral-950">
                        <img
                          src={wp.url}
                          alt={wp.name}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                        {isActive && (
                          <div className="absolute top-2 right-2 bg-blue-600 text-white p-1 rounded-full shadow">
                            <Check className="w-3 h-3" />
                          </div>
                        )}
                      </div>
                      <div className="text-xs font-medium text-white truncate">{wp.name}</div>
                      <div className="text-[10px] text-slate-400 truncate">{wp.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Section: Home Network & Wi-Fi */}
        {activeSection === 'network' && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Wifi className="w-5 h-5 text-cyan-400" />
                <span>Home Network & Wi-Fi Connection</span>
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Connect your ESP32-S3 to your home router so the Windows 11 WebOS is accessible to any phone, tablet, or PC on your local network.
              </p>
            </div>

            {/* Connection Status Banner */}
            <div className="p-5 bg-[#1f2533] rounded-2xl border border-neutral-700/60 space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
                <div className="flex items-center gap-3">
                  <div className={`w-3.5 h-3.5 rounded-full ${netConfig.isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                  <div>
                    <div className="text-sm font-semibold text-white flex items-center gap-2">
                      <span>{netConfig.isConnected ? `Connected to "${netConfig.homeSsid}"` : 'Disconnected from Home Wi-Fi'}</span>
                      {netConfig.isConnected && (
                        <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded font-mono border border-emerald-500/30">
                          Active LAN
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      Mode: <span className="font-mono text-cyan-300">Dual AP + Station (WIFI_MODE_APSTA)</span>
                    </div>
                  </div>
                </div>

                {netConfig.isConnected && (
                  <button
                    type="button"
                    onClick={handleDisconnectHomeWifi}
                    className="px-3 py-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-300 border border-red-500/30 text-xs font-medium transition-colors"
                  >
                    Disconnect
                  </button>
                )}
              </div>

              {/* IP & mDNS Address Card */}
              {netConfig.isConnected ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
                  <div className="p-2.5 bg-neutral-900 rounded-xl border border-neutral-800">
                    <span className="text-slate-400 text-[10px] font-sans">Home LAN IP:</span>
                    <div className="text-sm font-bold text-emerald-300 mt-0.5 truncate">{netConfig.ipAddress}</div>
                  </div>
                  <div className="p-2.5 bg-neutral-900 rounded-xl border border-neutral-800">
                    <span className="text-slate-400 text-[10px] font-sans">mDNS URL:</span>
                    <div className="text-sm font-bold text-blue-300 mt-0.5 truncate">http://{netConfig.mdnsHostname}</div>
                  </div>
                  <div className="p-2.5 bg-neutral-900 rounded-xl border border-neutral-800">
                    <span className="text-slate-400 text-[10px] font-sans">Signal RSSI:</span>
                    <div className="text-sm font-bold text-white mt-0.5">{netConfig.rssi} dBm</div>
                  </div>
                  <div className="p-2.5 bg-neutral-900 rounded-xl border border-neutral-800">
                    <span className="text-slate-400 text-[10px] font-sans">SoftAP Fallback:</span>
                    <div className="text-sm font-bold text-amber-300 mt-0.5">{netConfig.apIpAddress}</div>
                  </div>
                </div>
              ) : (
                <div className="p-3 bg-neutral-900 rounded-lg text-xs text-slate-300">
                  Select your home Wi-Fi network below and enter the password to connect.
                </div>
              )}
            </div>

            {wifiNotice && (
              <div className={`p-3.5 rounded-xl border text-xs flex items-center gap-2 ${
                wifiNotice.type === 'success'
                  ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
                  : 'bg-red-950/60 border-red-800 text-red-300'
              }`}>
                {wifiNotice.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                <span>{wifiNotice.text}</span>
              </div>
            )}

            {/* Connect to Home Wi-Fi Form & Scanner */}
            <div className="p-5 bg-[#1f2533] rounded-2xl border border-neutral-700/60 space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-white">
                  Available Networks in Range
                </div>
                <button
                  type="button"
                  onClick={handleScanWifi}
                  disabled={isScanningWifi}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-slate-200 text-xs border border-neutral-700 transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isScanningWifi ? 'animate-spin text-cyan-400' : ''}`} />
                  <span>{isScanningWifi ? 'Scanning...' : 'Scan Networks'}</span>
                </button>
              </div>

              {/* Scanned Network List */}
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {availableNetworks.map((net) => {
                  const isChosen = selectedSsid === net.ssid;
                  return (
                    <button
                      key={net.ssid}
                      type="button"
                      onClick={() => setSelectedSsid(net.ssid)}
                      className={`w-full flex items-center justify-between p-2.5 rounded-xl text-xs transition-colors border ${
                        isChosen
                          ? 'bg-blue-600/20 border-blue-500/50 text-white'
                          : 'bg-neutral-900/60 border-neutral-800/80 hover:bg-neutral-800/50 text-slate-300'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <Wifi className="w-4 h-4 text-cyan-400" />
                        <span className="font-medium">{net.ssid}</span>
                        {net.isHomeNetwork && (
                          <span className="text-[10px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded font-mono">
                            Home Network
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-slate-400 font-mono text-[11px]">
                        <span>{net.security}</span>
                        <span>{net.rssi} dBm</span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* SSID & Password Connection inputs */}
              <form onSubmit={handleConnectHomeWifi} className="pt-2 border-t border-neutral-800 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Network SSID</label>
                    <input
                      type="text"
                      placeholder="Enter home Wi-Fi SSID"
                      value={selectedSsid}
                      onChange={(e) => setSelectedSsid(e.target.value)}
                      required
                      className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Wi-Fi Password (WPA2/WPA3)</label>
                    <input
                      type="password"
                      placeholder="Enter Wi-Fi password"
                      value={homePasswordInput}
                      onChange={(e) => setHomePasswordInput(e.target.value)}
                      className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={isConnectingWifi || !selectedSsid.trim()}
                    className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white rounded-xl text-xs font-medium transition-colors shadow disabled:opacity-50"
                  >
                    {isConnectingWifi ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Connecting to Home Network...</span>
                      </>
                    ) : (
                      <>
                        <Wifi className="w-3.5 h-3.5" />
                        <span>Connect to Home Network</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Section: UAC & Security */}
        {activeSection === 'security' && (
          <div className="max-w-2xl space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white">User Account Control (UAC) Settings</h2>
              <p className="text-xs text-slate-400 mt-1">
                Configure when Windows prompts for elevation before running .exe files or altering system configuration
              </p>
            </div>

            <div className="p-5 bg-[#1f2533] rounded-xl border border-neutral-700/60 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">Current Protection Level:</span>
                <span className="text-xs font-mono font-medium px-2.5 py-1 rounded bg-blue-600/30 text-blue-300 border border-blue-500/30">
                  Level {uacLevel} of 3
                </span>
              </div>

              {/* Slider representation */}
              <div className="space-y-3">
                <input
                  type="range"
                  min="0"
                  max="3"
                  step="1"
                  value={uacLevel}
                  onChange={(e) => handleUpdateUac(Number(e.target.value))}
                  className="w-full accent-blue-500 cursor-pointer h-2 bg-neutral-900 rounded-lg"
                />

                <div className="p-4 bg-neutral-900/80 rounded-lg border border-neutral-800 text-xs space-y-2">
                  {uacLevel === 3 && (
                    <>
                      <div className="font-bold text-amber-300 flex items-center gap-1.5">
                        <AlertCircle className="w-4 h-4" />
                        <span>Always notify (Recommended for maximum security)</span>
                      </div>
                      <p className="text-slate-300 leading-relaxed">
                        Notify me when apps try to install software, execute unrecognized .exe binaries from the USB drive, or make changes to the ESP32-S3 firmware. Always prompts for administrator password.
                      </p>
                    </>
                  )}
                  {uacLevel === 2 && (
                    <>
                      <div className="font-bold text-blue-300 flex items-center gap-1.5">
                        <Check className="w-4 h-4" />
                        <span>Notify me only when apps try to make changes (Default)</span>
                      </div>
                      <p className="text-slate-300 leading-relaxed">
                        Notify me when apps try to make changes to my computer (such as executing privileged .exe files or writing to /usb/system/). Dims the desktop and presents the authentic UAC prompt.
                      </p>
                    </>
                  )}
                  {uacLevel === 1 && (
                    <>
                      <div className="font-bold text-slate-300">
                        Notify me only when apps try to make changes (do not dim my desktop)
                      </div>
                      <p className="text-slate-400">
                        Shows UAC elevation prompts without dimming the desktop screen.
                      </p>
                    </>
                  )}
                  {uacLevel === 0 && (
                    <>
                      <div className="font-bold text-red-400">
                        Never notify (Not recommended)
                      </div>
                      <p className="text-slate-400">
                        Disables UAC checks. All executables and system modifications run without elevation prompts.
                      </p>
                    </>
                  )}
                </div>
              </div>

              {uacSaved && (
                <div className="text-xs text-emerald-400 font-medium">
                  ✓ UAC security policy updated successfully.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
