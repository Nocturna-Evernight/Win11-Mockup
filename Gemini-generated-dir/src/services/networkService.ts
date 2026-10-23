export interface WifiNetwork {
  ssid: string;
  rssi: number; // dBm
  channel: number;
  security: 'WPA2-PSK' | 'WPA3-SAE' | 'WPA2/WPA3' | 'OPEN';
  isHomeNetwork?: boolean;
}

export interface NetworkConfig {
  mode: 'APSTA' | 'STA' | 'AP';
  homeSsid: string;
  homePassword?: string;
  isConnected: boolean;
  ipAddress: string;
  gateway: string;
  subnet: string;
  dns: string;
  mdnsHostname: string;
  rssi: number;
  apSsid: string;
  apPassword?: string;
  apIpAddress: string;
}

const STORAGE_KEY = 'esp32s3_home_wifi_config_v2';

const DEFAULT_CONFIG: NetworkConfig = {
  mode: 'APSTA', // Dual mode: Connected to Home Network + SoftAP recovery
  homeSsid: 'Home-WiFi-5G',
  homePassword: 'password123',
  isConnected: true,
  ipAddress: '192.168.1.145',
  gateway: '192.168.1.1',
  subnet: '255.255.255.0',
  dns: '1.1.1.1',
  mdnsHostname: 'esp32-win11.local',
  rssi: -54,
  apSsid: 'ESP32-S3-Win11',
  apPassword: 'windows11',
  apIpAddress: '192.168.4.1',
};

const NEARBY_NETWORKS: WifiNetwork[] = [
  { ssid: 'Home-WiFi-5G', rssi: -54, channel: 6, security: 'WPA2/WPA3', isHomeNetwork: true },
  { ssid: 'Home-WiFi-IoT', rssi: -62, channel: 1, security: 'WPA2-PSK' },
  { ssid: 'LivingRoom_Mesh', rssi: -68, channel: 11, security: 'WPA3-SAE' },
  { ssid: 'Neighbor_Network', rssi: -82, channel: 3, security: 'WPA2-PSK' },
  { ssid: 'Office_Guest', rssi: -76, channel: 6, security: 'OPEN' },
];

class NetworkService {
  private config: NetworkConfig;
  private listeners: ((cfg: NetworkConfig) => void)[] = [];

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): NetworkConfig {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
      }
    } catch (e) {
      console.warn('Failed to load wifi config:', e);
    }
    return DEFAULT_CONFIG;
  }

  private saveConfig(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch (e) {
      console.error('Failed to save wifi config:', e);
    }
    this.notify();
  }

  public getConfig(): NetworkConfig {
    return { ...this.config };
  }

  public scanNetworks(): Promise<WifiNetwork[]> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(NEARBY_NETWORKS);
      }, 700);
    });
  }

  public async connectToHomeNetwork(ssid: string, password?: string): Promise<{ success: boolean; message: string }> {
    // Simulate connection handshake on ESP32-S3
    this.config.homeSsid = ssid;
    this.config.homePassword = password;
    this.config.isConnected = false;
    this.saveConfig();

    return new Promise((resolve) => {
      setTimeout(() => {
        // Generate pseudo-random realistic LAN IP on home subnet
        const hostOctet = Math.floor(100 + Math.random() * 80);
        this.config.isConnected = true;
        this.config.ipAddress = `192.168.1.${hostOctet}`;
        this.config.rssi = -52;
        this.saveConfig();
        resolve({
          success: true,
          message: `Connected to "${ssid}". Assigned Home IP: ${this.config.ipAddress}. WebOS accessible at http://${this.config.ipAddress} or http://${this.config.mdnsHostname}`,
        });
      }, 1200);
    });
  }

  public disconnectHomeNetwork(): void {
    this.config.isConnected = false;
    this.config.ipAddress = '';
    this.config.homeSsid = '';
    this.config.homePassword = '';
    this.saveConfig();
  }

  public updateMdns(hostname: string): void {
    this.config.mdnsHostname = hostname;
    this.saveConfig();
  }

  public updateApConfig(ssid: string, pass: string): void {
    this.config.apSsid = ssid;
    this.config.apPassword = pass;
    this.saveConfig();
  }

  public subscribe(fn: (cfg: NetworkConfig) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      fn(this.getConfig());
    }
  }
}

export const networkService = new NetworkService();
