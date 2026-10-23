export interface StorageEntry {
  name: string;
  path: string;
  isFolder: boolean;
  size: number;
}

export interface StorageListResponse {
  path: string;
  truncated: boolean;
  entries: StorageEntry[];
}

export interface DownloadResponse {
  blob: Blob;
  filename: string;
  contentType: string;
}

const base64Encode = (str: string): string => {
  return btoa(unescape(encodeURIComponent(str)));
};

class StorageService {
  private baseUrl = '';

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, '');
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Storage API error: ${response.status} ${errorText}`);
    }
    return response.json() as Promise<T>;
  }

  private async requestBlob(endpoint: string, options?: RequestInit): Promise<Blob> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        ...options?.headers,
      },
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Storage API error: ${response.status} ${errorText}`);
    }
    return response.blob();
  }

  async listDirectory(logicalPath: string): Promise<StorageListResponse> {
    const encodedPath = base64Encode(logicalPath);
    return this.request<StorageListResponse>(`/api/storage/list`, {
      method: 'GET',
      headers: {
        'X-USB-Path': encodedPath,
      },
    });
  }

  async readTextFile(logicalPath: string): Promise<string> {
    const encodedPath = base64Encode(logicalPath);
    const response = await fetch(`${this.baseUrl}/api/storage/read`, {
      method: 'GET',
      headers: {
        'X-USB-Path': encodedPath,
      },
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Storage read error: ${response.status} ${errorText}`);
    }
    return response.text();
  }

  async downloadFile(logicalPath: string): Promise<DownloadResponse> {
    const encodedPath = base64Encode(logicalPath);
    const response = await fetch(`${this.baseUrl}/api/storage/download`, {
      method: 'GET',
      headers: {
        'X-USB-Path': encodedPath,
      },
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Storage download error: ${response.status} ${errorText}`);
    }
    const blob = await response.blob();
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = logicalPath.split('/').pop() || 'download';
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match) filename = match[1];
    }
    return {
      blob,
      filename,
      contentType: response.headers.get('Content-Type') || 'application/octet-stream',
    };
  }

  async triggerDownload(logicalPath: string): Promise<void> {
    const { blob, filename } = await this.downloadFile(logicalPath);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async createFolder(parentPath: string, name: string): Promise<void> {
    const encodedParent = base64Encode(parentPath);
    await this.request('/api/storage/action', {
      method: 'POST',
      headers: {
        'X-USB-Path': encodedParent,
      },
      body: JSON.stringify({ action: 'mkdir', name }),
    });
  }

  async deleteFile(logicalPath: string): Promise<void> {
    const encodedPath = base64Encode(logicalPath);
    await this.request('/api/storage/action', {
      method: 'POST',
      headers: {
        'X-USB-Path': encodedPath,
      },
      body: JSON.stringify({ action: 'delete' }),
    });
  }

  async renameFile(logicalPath: string, newName: string): Promise<void> {
    const encodedPath = base64Encode(logicalPath);
    await this.request('/api/storage/action', {
      method: 'POST',
      headers: {
        'X-USB-Path': encodedPath,
      },
      body: JSON.stringify({ action: 'rename', name: newName }),
    });
  }

  async uploadFile(logicalPath: string, file: File): Promise<void> {
    const encodedPath = base64Encode(logicalPath);
    const formData = new FormData();
    formData.append('file', file);
    
    const response = await fetch(`${this.baseUrl}/api/storage/upload`, {
      method: 'POST',
      headers: {
        'X-USB-Path': encodedPath,
      },
      body: formData,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Storage upload error: ${response.status} ${errorText}`);
    }
  }
}

export const storageService = new StorageService();