import { ThermalTelemetry, ThermalZone } from '../types';

interface DeviceTemperatureResponse {
  temperatureValid?: boolean;
  temperatureCelsius?: number | null;
  stressTestRunning?: boolean;
}

const SAMPLE_COUNT = 30;
const WARNING_THRESHOLD_C = 75;
const CRITICAL_DISPLAY_THRESHOLD_C = 85;

class ThermalService {
  private dieTempC = 0;
  private minTempC = 0;
  private maxTempC = 0;
  private sensorAvailable = false;
  private sensorError: string | null = null;
  private isLoadTestRunning = false;
  private unit: 'C' | 'F' = 'C';
  private history: { time: string; tempC: number; cpuLoad: number }[] = [];
  private listeners: ((telemetry: ThermalTelemetry) => void)[] = [];
  private timer: number | undefined;
  private requestInFlight = false;

  constructor() {
    void this.refreshNow();
    this.timer = window.setInterval(() => void this.refreshNow(), 2000);
  }

  public async refreshNow(): Promise<void> {
    if (this.requestInFlight) return;
    this.requestInFlight = true;
    try {
      const response = await fetch('/api/system/stats', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Device returned HTTP ${response.status}`);
      const sample = await response.json() as DeviceTemperatureResponse;
      if (sample.temperatureValid !== true ||
          typeof sample.temperatureCelsius !== 'number' ||
          !Number.isFinite(sample.temperatureCelsius)) {
        throw new Error('ESP32 temperature sensor has not returned a valid reading.');
      }

      this.dieTempC = sample.temperatureCelsius;
      this.minTempC = this.sensorAvailable ? Math.min(this.minTempC, this.dieTempC) : this.dieTempC;
      this.maxTempC = this.sensorAvailable ? Math.max(this.maxTempC, this.dieTempC) : this.dieTempC;
      this.sensorAvailable = true;
      this.sensorError = null;
      this.isLoadTestRunning = sample.stressTestRunning === true;
      const now = new Date();
      this.history = [...this.history.slice(-(SAMPLE_COUNT - 1)), {
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        tempC: this.dieTempC,
        cpuLoad: 0,
      }];
    } catch (cause) {
      this.sensorAvailable = false;
      this.sensorError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      this.requestInFlight = false;
      this.notify();
    }
  }

  public getTelemetry(): ThermalTelemetry {
    const dieTempF = this.dieTempC * 9 / 5 + 32;
    const status: ThermalZone['status'] = this.dieTempC >= CRITICAL_DISPLAY_THRESHOLD_C
      ? 'critical'
      : this.dieTempC >= WARNING_THRESHOLD_C
        ? 'hot'
        : 'optimal';
    const zones: ThermalZone[] = this.sensorAvailable ? [{
      id: 'zone_soc',
      name: 'ESP32-S3 on-die temperature sensor',
      component: 'Internal SoC sensor; not an external board/room sensor',
      tempC: this.dieTempC,
      warningThresholdC: WARNING_THRESHOLD_C,
      criticalDisplayC: CRITICAL_DISPLAY_THRESHOLD_C,
      status,
    }] : [];

    return {
      dieTempC: this.dieTempC,
      dieTempF,
      minTempC: this.minTempC,
      maxTempC: this.maxTempC,
      sensorAvailable: this.sensorAvailable,
      sensorError: this.sensorError,
      isAboveWarningThreshold: this.sensorAvailable && this.dieTempC >= WARNING_THRESHOLD_C,
      isLoadTestRunning: this.isLoadTestRunning,
      warningThresholdC: WARNING_THRESHOLD_C,
      criticalDisplayC: CRITICAL_DISPLAY_THRESHOLD_C,
      history: [...this.history],
      zones,
    };
  }

  public getUnit(): 'C' | 'F' {
    return this.unit;
  }

  public setUnit(unit: 'C' | 'F') {
    this.unit = unit;
    this.notify();
  }

  public async startLoadTest(): Promise<void> {
    const response = await fetch('/api/system/stress', { method: 'POST' });
    if (!response.ok) {
      throw new Error(`Could not start ESP32 load test: ${await response.text()} (HTTP ${response.status})`);
    }
    await this.refreshNow();
  }

  public subscribe(fn: (telemetry: ThermalTelemetry) => void): () => void {
    this.listeners.push(fn);
    fn(this.getTelemetry());
    return () => {
      this.listeners = this.listeners.filter((listener) => listener !== fn);
    };
  }

  private notify() {
    const data = this.getTelemetry();
    this.listeners.forEach((listener) => listener(data));
  }
}

export const thermalService = new ThermalService();
