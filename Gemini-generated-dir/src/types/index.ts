export interface FsNode {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  size: number; // in bytes
  modified: string;
  content?: string;
  parentPath: string;
  isExecutable?: boolean;
  isImage?: boolean;
  requiresUac?: boolean;
  icon?: string;
  description?: string;
}

export type UacPrivilegeLevel = 'standard' | 'elevated' | 'system';

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
  isAdmin: boolean;
  hasPassword: boolean;
  passwordHash: string; // SHA-256
  uacLevel: number; // 0: Never notify, 1: Low, 2: Default (Prompt on app change), 3: Always notify
  createdDate: string;
}

export type WindowAppType = 
  | 'explorer' 
  | 'terminal' 
  | 'taskmgr' 
  | 'notepad' 
  | 'settings' 
  | 'firmware'
  | 'hardware'
  | 'media'
  | 'calculator'
  | 'office'
  | 'hardwareControls'
  | 'remoteBrowser'
  | 'snake'
  | 'minesweeper'
  | 'pong'
  | 'updateManager'
  | 'devStudio'
  | 'dynamicApp'
  | 'myGame'
  | (string & {});

export interface AppWindow {
  id: string;
  appType: WindowAppType;
  title: string;
  icon: string;
  isOpen: boolean;
  isMinimized: boolean;
  isMaximized: boolean;
  zIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  data?: any;
  requiresAdmin?: boolean;
}

export interface UacRequest {
  id: string;
  appName: string;
  publisher: string;
  filePath: string;
  icon?: string;
  onConfirm: () => void;
  onCancel: () => void;
  requiresAdminPassword?: boolean;
}

export interface EspHardwareStats {
  chipModel: string;
  flashSizeMb: number;
  psramTotalKb: number;
  psramUsedKb: number;
  internalSramKb: number;
  internalSramUsedKb: number;
  usbTotalGb: number;
  usbUsedGb: number;
  cpuFreqMhz: number;
  cpu0LoadPercent: number;
  cpu1LoadPercent: number;
  usbTransferRateKbps: number;
  uptimeSeconds: number;
  wifiSsid: string;
  wifiIp: string;
  temperatureCelsius: number;
  temperatureFahrenheit: number;
  isThrottling: boolean;
}

export interface FreeRtosTaskSnapshot {
  name: string;
  taskNumber: number;
  state: string;
  priority: number;
  coreAffinity: number;
  stackHighWaterBytes: number;
}

export interface FirmwareDriverSnapshot {
  name: string;
  state: string;
  details?: string;
  allocatedBytes?: number;
}

export interface FirmwareSystemSnapshot {
  chipModel: string;
  firmwareVersion: string;
  idfVersion: string;
  chipRevision: number;
  cpuCores: number;
  cpuFrequencyHz: number;
  uptimeSeconds: number;
  flashSizeValid: boolean;
  flashSizeBytes: number | null;
  psramTotalBytes: number;
  psramFreeBytes: number;
  psramMinimumFreeBytes: number;
  psramLargestBlockBytes: number;
  internalHeapTotalBytes: number;
  internalHeapFreeBytes: number;
  internalHeapMinimumFreeBytes: number;
  internalHeapLargestBlockBytes: number;
  coreUtilizationPercent: (number | null)[];
  taskCount: number;
  taskTraceAvailable: boolean;
  taskListError?: string;
  tasks: FreeRtosTaskSnapshot[];
  usbMounted: boolean;
  usbTotalGb: number;
  usbManufacturer: string;
  usbProduct: string;
  httpServerRunning: boolean;
  wifiDriverStarted: boolean;
  wifiMode: string;
  wifiStationConnected: boolean;
  wifiStationSsid: string | null;
  wifiStationIp: string | null;
  wifiApSsid: string | null;
  wifiApIp: string | null;
  wifiApClientCount: number | null;
  gpioOutputs: { pin: number; configured: boolean; level: number | null }[];
  drivers: FirmwareDriverSnapshot[];
}

export interface ThermalZone {
  id: string;
  name: string;
  component: string;
  tempC: number;
  warningThresholdC: number;
  criticalDisplayC: number;
  status: 'optimal' | 'warm' | 'hot' | 'critical';
}

export interface ThermalTelemetry {
  dieTempC: number;
  dieTempF: number;
  minTempC: number;
  maxTempC: number;
  sensorAvailable: boolean;
  sensorError: string | null;
  isAboveWarningThreshold: boolean;
  isLoadTestRunning: boolean;
  warningThresholdC: number;
  criticalDisplayC: number;
  history: { time: string; tempC: number; cpuLoad: number }[];
  zones: ThermalZone[];
}

export interface OtaStatus {
  state: 'idle' | 'reading' | 'writing' | 'verifying' | 'done' | 'error';
  progressPercent: number;
  bytesWritten: number;
  totalBytes: number;
  errorMessage: string | null;
}
