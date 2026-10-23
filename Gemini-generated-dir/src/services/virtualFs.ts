import { FsNode } from '../types';

const STORAGE_KEY = 'esp32s3_win11_usb_drive_v2';

const INITIAL_NODES: FsNode[] = [
  // Drive Roots
  {
    id: 'drive_c',
    name: 'Local Disk (C:)',
    path: 'C:',
    isFolder: true,
    size: 16 * 1024 * 1024,
    modified: '2026-10-01 10:00',
    parentPath: '',
    description: 'Internal 16MB Quad SPI Flash (Firmware & Recovery VFS)',
  },
  {
    id: 'drive_d',
    name: 'USB Drive (D:)',
    path: 'D:',
    isFolder: true,
    size: 32 * 1024 * 1024 * 1024,
    modified: '2026-10-03 08:30',
    parentPath: '',
    description: 'Primary 32GB USB-OTG Flash Drive (FAT32 / Mounted on GPIO 19/20)',
  },

  // Drive C contents (Internal Flash)
  {
    id: 'c_boot',
    name: 'boot',
    path: 'C:\\boot',
    isFolder: true,
    size: 0,
    modified: '2026-10-01 10:00',
    parentPath: 'C:',
  },
  {
    id: 'c_firmware',
    name: 'esp32s3_win11.bin',
    path: 'C:\\boot\\esp32s3_win11.bin',
    isFolder: false,
    size: 3145728, // 3MB
    modified: '2026-10-01 10:00',
    parentPath: 'C:\\boot',
    content: 'ESP32-S3 Application Binary Image (compiled with ESP-IDF v5.1, Xtensa LX7 dual core 240MHz)',
  },

  // Drive D: Windows structure on 32GB Flash Drive
  {
    id: 'd_windows',
    name: 'Windows',
    path: 'D:\\Windows',
    isFolder: true,
    size: 0,
    modified: '2026-10-03 08:30',
    parentPath: 'D:',
  },
  {
    id: 'd_sys32',
    name: 'System32',
    path: 'D:\\Windows\\System32',
    isFolder: true,
    size: 0,
    modified: '2026-10-03 08:30',
    parentPath: 'D:\\Windows',
  },
  // Program Files

  // Users folder
  {
    id: 'd_users',
    name: 'Users',
    path: 'D:\\Users',
    isFolder: true,
    size: 0,
    modified: '2026-10-03 08:30',
    parentPath: 'D:',
  },
  {
    id: 'd_user_admin',
    name: 'Administrator',
    path: 'D:\\Users\\Administrator',
    isFolder: true,
    size: 0,
    modified: '2026-10-03 08:30',
    parentPath: 'D:\\Users',
  },
  {
    id: 'd_user_admin_desktop',
    name: 'Desktop',
    path: 'D:\\Users\\Administrator\\Desktop',
    isFolder: true,
    size: 0,
    modified: '2026-10-03 08:30',
    parentPath: 'D:\\Users\\Administrator',
  },
  {
    id: 'd_sys_info',
    name: 'ESP32S3_N16R8_Specs.txt',
    path: 'D:\\Users\\Administrator\\Desktop\\ESP32S3_N16R8_Specs.txt',
    isFolder: false,
    size: 1240,
    modified: '2026-10-03 08:30',
    parentPath: 'D:\\Users\\Administrator\\Desktop',
    content: `=====================================================
ESP32-S3-WROOM-1-N16R8 Hardware Specifications
=====================================================
Processor:      Dual-Core 32-bit Xtensa LX7 @ 240 MHz
Flash Memory:   16 MB Quad SPI Flash (Primary ROM/Firmware)
PSRAM Memory:   8 MB Octal SPI RAM (80 MHz high speed)
USB Interface:  Native USB 2.0 Full Speed (12 Mbps) OTG Host
External Drive: 32 GB USB Flash Drive (Mounted via FATFS at D:\\)
Wi-Fi:          802.11 b/g/n (2.4 GHz SoftAP & Station)
Bluetooth:      BLE 5.0 Mesh

Operating System: Windows 11 WebOS Simulation Server
Persistence:    Active (32GB USB MSC FATFS)
UAC Elevation:  Enabled (Prompt for Administrator credentials)
=====================================================`,
  },
  {
    id: 'd_user_admin_docs',
    name: 'Documents',
    path: 'D:\\Users\\Administrator\\Documents',
    isFolder: true,
    size: 0,
    modified: '2026-10-03 08:30',
    parentPath: 'D:\\Users\\Administrator',
  },
  {
    id: 'd_wiring_doc',
    name: 'USB_OTG_Wiring.txt',
    path: 'D:\\Users\\Administrator\\Documents\\USB_OTG_Wiring.txt',
    isFolder: false,
    size: 890,
    modified: '2026-10-03 08:30',
    parentPath: 'D:\\Users\\Administrator\\Documents',
    content: `USB-OTG Host Hardware Wiring for 32GB Flash Drive:
------------------------------------------------------
ESP32-S3 Pin 19  -->  USB Type-A D- (Pin 2, White)
ESP32-S3 Pin 20  -->  USB Type-A D+ (Pin 3, Green)
ESP32-S3 GND     -->  USB Type-A GND (Pin 4, Black)
5V Power Rail    -->  USB Type-A VBUS +5V (Pin 1, Red)

Important: Provide 5V to the USB drive VBUS pin! The 3.3V pin on the ESP32-S3
is not sufficient for USB flash drives.`,
  },
  {
    id: 'd_user_kennard',
    name: 'Kennard',
    path: 'D:\\Users\\Kennard',
    isFolder: true,
    size: 0,
    modified: '2026-10-03 08:30',
    parentPath: 'D:\\Users',
  },
  {
    id: 'd_kennard_desktop',
    name: 'Desktop',
    path: 'D:\\Users\\Kennard\\Desktop',
    isFolder: true,
    size: 0,
    modified: '2026-10-03 08:30',
    parentPath: 'D:\\Users\\Kennard',
  },
  {
    id: 'd_welcome_txt',
    name: 'Welcome.txt',
    path: 'D:\\Users\\Kennard\\Desktop\\Welcome.txt',
    isFolder: false,
    size: 620,
    modified: '2026-10-03 08:30',
    parentPath: 'D:\\Users\\Kennard\\Desktop',
    content: `Welcome to Windows 11 on ESP32-S3 N16R8!
---------------------------------------------
You are running a complete Windows 11 WebOS simulator connected
to a 32GB USB-OTG flash drive and utilizing 8MB Octal PSRAM.

Features you can test right now:
1. Browse USB files and open supported text, media, and office documents
2. Use the Terminal for filesystem commands such as 'dir', 'mem', and 'help'
3. Open Task Manager to view PSRAM and dual-core Xtensa statistics
4. Switch user profiles or change passwords in Settings -> Accounts
5. Export the ESP-IDF project to build and flash the firmware`,
  },

  // System folder on USB for persistence
  {
    id: 'd_sys',
    name: 'System',
    path: 'D:\\System',
    isFolder: true,
    size: 0,
    modified: '2026-10-03 08:30',
    parentPath: 'D:',
  },
  {
    id: 'd_reg_json',
    name: 'registry.json',
    path: 'D:\\System\\registry.json',
    isFolder: false,
    size: 840,
    modified: '2026-10-03 08:30',
    parentPath: 'D:\\System',
    requiresUac: true,
    content: JSON.stringify({
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management": {
        "PhysicalRamBytes": 8388608,
        "OctalSpiRamSpeedMhz": 80,
        "FlashStorageBytes": 34359738368
      },
      "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion": {
        "ProductName": "Windows 11 Pro on ESP32-S3",
        "CurrentBuild": "22631.3007",
        "RegisteredOwner": "Kennard"
      }
    }, null, 2),
  }
];

export interface UsbDiskInfo {
  vendor: string;
  model: string;
  vendorId: string;
  productId: string;
  productRevision: string;
  scsiInquiry: string;
  sectorSize: number;
  totalSectors: number;
  capacityBytes: number;
  capacityGb: number;
  filesystemTotalBytes: number | null;
  filesystemFreeBytes: number | null;
  usedBytes: number | null;
  clusterSizeKb: number;
  serialNumber: string;
  isAutoDetected: boolean;
  status: 'ONLINE' | 'SCANNING' | 'EJECTED';
}

const USB_INFO_KEY = 'esp32s3_usb_disk_info_v4';

const DEFAULT_USB_INFO: UsbDiskInfo = {
  vendor: 'Unknown',
  model: 'No drive detected',
  vendorId: 'N/A',
  productId: 'N/A',
  productRevision: 'Not provided',
  scsiInquiry: '',
  sectorSize: 0,
  totalSectors: 0,
  capacityBytes: 0,
  capacityGb: 0,
  filesystemTotalBytes: null,
  filesystemFreeBytes: null,
  usedBytes: null,
  clusterSizeKb: 0,
  serialNumber: 'Not provided',
  isAutoDetected: false,
  status: 'EJECTED',
};

class VirtualFileSystem {
  private nodes: FsNode[];
  private usbInfo: UsbDiskInfo;
  private listeners: (() => void)[] = [];

  constructor() {
    this.nodes = this.loadFromStorage();
    this.usbInfo = this.loadUsbInfo();
  }

  private loadUsbInfo(): UsbDiskInfo {
    try {
      const stored = localStorage.getItem(USB_INFO_KEY);
      if (stored) {
        return { ...DEFAULT_USB_INFO, ...JSON.parse(stored) };
      }
    } catch (e) {
      console.warn('Failed to load USB info:', e);
    }
    return DEFAULT_USB_INFO;
  }

  private saveUsbInfo(): void {
    try {
      localStorage.setItem(USB_INFO_KEY, JSON.stringify(this.usbInfo));
    } catch (e) {
      console.error('Failed to save USB info:', e);
    }
    this.notify();
  }

  public getUsbDiskInfo(): UsbDiskInfo {
    return { ...this.usbInfo };
  }

  public async autoDetectDisk(showScanning = true): Promise<UsbDiskInfo> {
    if (showScanning) {
      this.usbInfo.status = 'SCANNING';
      this.notify();
    }

    try {
      const response = await fetch('/api/system/stats', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Device query failed with HTTP ${response.status}`);
      }

      const device = await response.json() as {
        usbMounted?: boolean;
        usbVid?: number;
        usbPid?: number;
        usbManufacturer?: string;
        usbProduct?: string;
        usbSerialNumber?: string;
        usbSectorSize?: number;
        usbTotalSectors?: number;
        usbCapacityBytes?: number;
        usbFilesystemTotalBytes?: number | null;
        usbFilesystemFreeBytes?: number | null;
      };
      const vid = device.usbVid;
      const pid = device.usbPid;
      const sectorSize = device.usbSectorSize;
      const totalSectors = device.usbTotalSectors;

      if (!device.usbMounted) {
        const wasMounted = this.usbInfo.status !== 'EJECTED' || this.usbInfo.capacityBytes !== 0;
        if (!wasMounted) {
          return { ...this.usbInfo };
        }
        this.usbInfo = { ...DEFAULT_USB_INFO };
        const rootD = this.getNodeByPath('D:');
        if (rootD) {
          rootD.size = 0;
          rootD.name = 'USB Drive (D:) [not detected]';
          rootD.description = 'No USB storage device detected by the ESP32.';
        }
        this.saveUsbInfo();
        this.saveToStorage();
        return { ...this.usbInfo };
      }
      if (
        typeof vid !== 'number' || !Number.isInteger(vid) || vid <= 0 ||
        typeof pid !== 'number' || !Number.isInteger(pid) || pid < 0 ||
        typeof sectorSize !== 'number' || !Number.isInteger(sectorSize) || sectorSize <= 0 ||
        typeof totalSectors !== 'number' || !Number.isInteger(totalSectors) || totalSectors <= 0
      ) {
        throw new Error('The ESP32 returned incomplete USB identity or capacity data.');
      }

      const capacityBytes = sectorSize * totalSectors;
      if (!Number.isSafeInteger(capacityBytes) ||
          (device.usbCapacityBytes !== undefined && device.usbCapacityBytes !== capacityBytes)) {
        throw new Error('The ESP32 returned invalid or inconsistent USB capacity data.');
      }
      const filesystemTotalBytes = device.usbFilesystemTotalBytes ?? null;
      const filesystemFreeBytes = device.usbFilesystemFreeBytes ?? null;
      if (
        (filesystemTotalBytes !== null &&
          (!Number.isSafeInteger(filesystemTotalBytes) || filesystemTotalBytes < 0)) ||
        (filesystemFreeBytes !== null &&
          (!Number.isSafeInteger(filesystemFreeBytes) || filesystemFreeBytes < 0)) ||
        (filesystemTotalBytes !== null && filesystemFreeBytes !== null &&
          filesystemFreeBytes > filesystemTotalBytes)
      ) {
        throw new Error('The ESP32 returned invalid filesystem capacity data.');
      }
      const usedBytes = filesystemTotalBytes !== null && filesystemFreeBytes !== null
        ? filesystemTotalBytes - filesystemFreeBytes
        : null;
      const vendorId = `0x${vid.toString(16).padStart(4, '0').toUpperCase()}`;
      const productId = `0x${pid.toString(16).padStart(4, '0').toUpperCase()}`;
      const vendor = device.usbManufacturer?.trim() || `USB vendor ${vendorId}`;
      const model = device.usbProduct?.trim() || `USB product ${productId}`;

      const nextUsbInfo: UsbDiskInfo = {
        ...this.usbInfo,
        vendor,
        model,
        vendorId,
        productId,
        productRevision: 'Not provided',
        scsiInquiry: `USB VID:PID ${vendorId}:${productId}`,
        sectorSize,
        totalSectors,
        capacityBytes,
        capacityGb: capacityBytes / (1024 ** 3),
        filesystemTotalBytes,
        filesystemFreeBytes,
        usedBytes,
        clusterSizeKb: 0,
        serialNumber: device.usbSerialNumber?.trim() || 'Not provided',
        isAutoDetected: true,
        status: 'ONLINE',
      };

      const rootD = this.getNodeByPath('D:');
      let rootNodeChanged = false;
      if (rootD) {
        const nextName = `USB Drive (D:) [${nextUsbInfo.capacityGb.toFixed(2)} GiB]`;
        const nextDescription = `${vendor} ${model} (${vendorId}:${productId})`;
        rootNodeChanged = rootD.size !== capacityBytes ||
          rootD.name !== nextName ||
          rootD.description !== nextDescription;
        rootD.size = capacityBytes;
        rootD.name = nextName;
        rootD.description = nextDescription;
      }

      const usbInfoChanged = JSON.stringify(this.usbInfo) !== JSON.stringify(nextUsbInfo);
      this.usbInfo = nextUsbInfo;
      if (usbInfoChanged) {
        this.saveUsbInfo();
      }
      if (rootNodeChanged) {
        this.saveToStorage();
      }
      return { ...this.usbInfo };
    } catch (error) {
      const wasMounted = this.usbInfo.status !== 'EJECTED' || this.usbInfo.capacityBytes !== 0;
      this.usbInfo = { ...DEFAULT_USB_INFO };
      const rootD = this.getNodeByPath('D:');
      if (rootD) {
        rootD.size = 0;
        rootD.name = 'USB Drive (D:) [not detected]';
        rootD.description = 'No USB storage device detected by the ESP32.';
      }
      if (wasMounted) {
        this.saveUsbInfo();
        this.saveToStorage();
      }
      throw error;
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

  private loadFromStorage(): FsNode[] {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        return JSON.parse(data);
      }
    } catch (e) {
      console.warn('Failed to load VFS from localStorage:', e);
    }
    return INITIAL_NODES;
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.nodes));
    } catch (e) {
      console.error('Failed to save VFS to localStorage:', e);
    }
  }

  public getAllNodes(): FsNode[] {
    return [...this.nodes];
  }

  public getChildren(parentPath: string): FsNode[] {
    const cleanParent = parentPath.endsWith('\\') && parentPath.length > 3 
      ? parentPath.slice(0, -1) 
      : parentPath;
    return this.nodes.filter(n => n.parentPath === cleanParent);
  }

  public getNodeByPath(path: string): FsNode | undefined {
    return this.nodes.find(n => n.path.toLowerCase() === path.toLowerCase());
  }

  public createFile(parentPath: string, name: string, content: string = '', isExecutable: boolean = false, requiresUac: boolean = false): FsNode {
    const normalizedParent = parentPath.endsWith('\\') && parentPath.length > 3
      ? parentPath.slice(0, -1)
      : parentPath;
    const fullPath = normalizedParent === 'C:' || normalizedParent === 'D:'
      ? `${normalizedParent}\\${name}`
      : `${normalizedParent}\\${name}`;

    const existing = this.getNodeByPath(fullPath);
    if (existing) {
      existing.content = content;
      existing.size = new Blob([content]).size;
      existing.modified = new Date().toISOString().replace('T', ' ').slice(0, 16);
      this.saveToStorage();
      return existing;
    }

    const newNode: FsNode = {
      id: 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      name,
      path: fullPath,
      isFolder: false,
      size: new Blob([content]).size,
      modified: new Date().toISOString().replace('T', ' ').slice(0, 16),
      parentPath: normalizedParent,
      content,
      isExecutable: isExecutable || name.toLowerCase().endsWith('.exe') || name.toLowerCase().endsWith('.com') || name.toLowerCase().endsWith('.bat'),
      requiresUac,
    };

    this.nodes.push(newNode);
    this.saveToStorage();
    return newNode;
  }

  public createFolder(parentPath: string, name: string): FsNode {
    const normalizedParent = parentPath.endsWith('\\') && parentPath.length > 3
      ? parentPath.slice(0, -1)
      : parentPath;
    const fullPath = normalizedParent === 'C:' || normalizedParent === 'D:'
      ? `${normalizedParent}\\${name}`
      : `${normalizedParent}\\${name}`;

    const existing = this.getNodeByPath(fullPath);
    if (existing) {
      return existing;
    }

    const newNode: FsNode = {
      id: 'folder_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      name,
      path: fullPath,
      isFolder: true,
      size: 0,
      modified: new Date().toISOString().replace('T', ' ').slice(0, 16),
      parentPath: normalizedParent,
    };

    this.nodes.push(newNode);
    this.saveToStorage();
    return newNode;
  }

  public deleteNode(path: string): boolean {
    if (path === 'C:' || path === 'D:') return false; // Cannot delete drive roots
    const initialLen = this.nodes.length;
    // Delete target and any children
    this.nodes = this.nodes.filter(n => n.path !== path && !n.path.startsWith(path + '\\'));
    if (this.nodes.length !== initialLen) {
      this.saveToStorage();
      return true;
    }
    return false;
  }

  public updateContent(path: string, newContent: string): boolean {
    const node = this.getNodeByPath(path);
    if (node && !node.isFolder) {
      node.content = newContent;
      node.size = new Blob([newContent]).size;
      node.modified = new Date().toISOString().replace('T', ' ').slice(0, 16);
      this.saveToStorage();
      return true;
    }
    return false;
  }

  public resetToFactory(): void {
    this.nodes = JSON.parse(JSON.stringify(INITIAL_NODES));
    this.saveToStorage();
  }

  public calculateDiskUsage(): { cUsed: number; cTotal: number; dUsed: number; dTotal: number } {
    let cUsed = 0;
    let dUsed = 0;

    for (const node of this.nodes) {
      if (node.path.startsWith('C:')) {
        cUsed += node.size;
      } else if (node.path.startsWith('D:')) {
        dUsed += node.size;
      }
    }

    return {
      cUsed,
      cTotal: 16 * 1024 * 1024,
      dUsed: dUsed + 1840000000, // Base OS footprint + user files
      dTotal: this.usbInfo.capacityBytes || (32 * 1024 * 1024 * 1024),
    };
  }
}

export const virtualFs = new VirtualFileSystem();
