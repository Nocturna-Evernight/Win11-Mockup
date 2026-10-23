import React, { useEffect, useRef, useState } from 'react';
import { 
  HardDrive, 
  Folder, 
  FileText, 
  ArrowLeft, 
  ArrowRight, 
  ArrowUp, 
  RotateCw, 
  Plus, 
  Upload, 
  Trash2, 
  Search, 
  Image as ImageIcon,
  ShieldAlert, 
  ChevronRight, 
  Database,
  RefreshCw,
  Sparkles,
  Music,
  Film,
  FileSpreadsheet,
  FileCode,
  Cpu,
  Globe,
  Download
} from 'lucide-react';
import { FsNode, WindowAppType } from '../../types';
import { virtualFs } from '../../services/virtualFs';
import { storageService } from '../../services/storageService';

interface FileExplorerProps {
  initialPath?: string;
  onOpenFile: (appType: WindowAppType, data: any) => void;
  onRequestUac: (appName: string, filePath: string, action: () => void) => void;
}

type AdminOperation = (password: string) => Promise<void>;

class AdminAuthorizationError extends Error {}

// ---------------------------------------------------------------------------
// File Association Engine
// Maps file extensions → the WindowAppType that should open them.
// ---------------------------------------------------------------------------

type FileAssociation = {
  appType: WindowAppType | 'unsupported';
  /** Whether the file can be fetched as text and passed as content */
  readAsText: boolean;
};

const MEDIA_EXTS   = /\.(mp3|mp4|wav|ogg|flac|aac|m4a|wma|avi|mkv|mov|webm|m4v)$/i;
const OFFICE_EXTS  = /\.(xlsx?|docx?|pptx?|ods|odt|odp|rtf|csv)$/i;
const BINARY_EXTS  = /\.(bin|elf|img|hex|exe|com|bat|firmware|fw)$/i;
const CODE_EXTS    = /\.(js|ts|jsx|tsx|py|c|cpp|h|rs|go|json|xml|yaml|yml|toml|ini|cfg|sh|bat|ps1|css|scss|less|java|kt|swift|rb|php)$/i;
const WEB_EXTS     = /\.(html?|app|webapp)$/i;

function getFileAssociation(name: string): FileAssociation {
  if (MEDIA_EXTS.test(name))  return { appType: 'media',      readAsText: false };
  if (OFFICE_EXTS.test(name)) return { appType: 'office',     readAsText: true  };
  if (BINARY_EXTS.test(name)) return { appType: 'unsupported', readAsText: false };
  if (WEB_EXTS.test(name))    return { appType: 'dynamicApp', readAsText: true  };
  // text / code / anything else → notepad
  return { appType: 'notepad', readAsText: true };
}

/** Returns the JSX icon to show in the file grid for a given FsNode. */
function FileTypeIcon({ item }: { item: FsNode }) {
  const cls = 'w-12 h-12 group-hover:scale-105 transition-transform';
  if (item.isFolder)     return <Folder      className={`${cls} text-amber-400 fill-amber-400/20`} />;
  if (item.isImage)                    return <ImageIcon      className={`${cls} text-violet-300 stroke-[1.5]`} />;
  if (MEDIA_EXTS.test(item.name)) {
    if (/\.(mp4|avi|mkv|mov|webm|m4v)$/i.test(item.name))
                                         return <Film         className={`${cls} text-pink-400 stroke-[1.5]`} />;
    return                                      <Music        className={`${cls} text-indigo-300 stroke-[1.5]`} />;
  }
  if (OFFICE_EXTS.test(item.name))     return <FileSpreadsheet className={`${cls} text-emerald-400 stroke-[1.5]`} />;
  if (BINARY_EXTS.test(item.name))     return <Cpu           className={`${cls} text-cyan-400 stroke-[1.5]`} />;
  if (WEB_EXTS.test(item.name))        return <Globe         className={`${cls} text-sky-400 stroke-[1.5]`} />;
  if (CODE_EXTS.test(item.name))       return <FileCode      className={`${cls} text-yellow-400 stroke-[1.5]`} />;
  return                                       <FileText     className={`${cls} text-sky-400 stroke-[1.5]`} />;
}

let usbAdminSessionPassword: string | null = null;

const encodeHeaderValue = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const FileExplorer: React.FC<FileExplorerProps> = ({
  initialPath = 'D:',
  onOpenFile,
  onRequestUac,
}) => {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [history, setHistory] = useState<string[]>([initialPath]);
  const [historyIdx, setHistoryIdx] = useState(0);
  const [searchFilter, setSearchFilter] = useState('');
  const [selectedNode, setSelectedNode] = useState<FsNode | null>(null);
  const [nodes, setNodes] = useState<FsNode[]>([]);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [usbDisk, setUsbDisk] = useState(virtualFs.getUsbDiskInfo());
  const [isDetectingDisk, setIsDetectingDisk] = useState(false);
  const [detectNotice, setDetectNotice] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageTruncated, setStorageTruncated] = useState(false);
  const [isLoadingStorage, setIsLoadingStorage] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ item: FsNode; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [pendingAdminOperation, setPendingAdminOperation] = useState<AdminOperation | null>(null);
  const [isAdminOperationRunning, setIsAdminOperationRunning] = useState(false);
  const [imagePreview, setImagePreview] = useState<{ name: string; url: string } | null>(null);
  const isPhysicalUsbView = currentPath.startsWith('D:') && usbDisk.status === 'ONLINE';

  useEffect(() => () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview.url);
  }, [imagePreview?.url]);

  useEffect(() => {
    if (!contextMenu) return;

    const dismissOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !contextMenuRef.current?.contains(event.target)) {
        setContextMenu(null);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };

    document.addEventListener('pointerdown', dismissOnOutsideClick);
    window.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOnOutsideClick);
      window.removeEventListener('keydown', dismissOnEscape);
    };
  }, [contextMenu]);

  const executeAdminOperation = async (
    operation: AdminOperation,
    password: string,
    rememberPassword: boolean,
  ) => {
    setIsAdminOperationRunning(true);
    setStorageError(null);
    try {
      await operation(password);
      if (rememberPassword) usbAdminSessionPassword = password;
      setPendingAdminOperation(null);
      setAdminPassword('');
      await refreshFiles();
    } catch (error) {
      if (error instanceof AdminAuthorizationError) {
        usbAdminSessionPassword = null;
        if (!rememberPassword) {
          setAdminPassword('');
          setPendingAdminOperation(() => operation);
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      setStorageError(message);
    } finally {
      setIsAdminOperationRunning(false);
    }
  };

  const requireAdmin = (operation: AdminOperation) => {
    if (usbAdminSessionPassword !== null) {
      void executeAdminOperation(operation, usbAdminSessionPassword, false);
      return;
    }
    setAdminPassword('');
    setPendingAdminOperation(() => operation);
  };

  const runAdminOperation = async () => {
    if (!pendingAdminOperation) return;
    await executeAdminOperation(pendingAdminOperation, adminPassword, true);
  };

  const postStorageAction = async (password: string, action: string, path: string, name?: string) => {
    const response = await fetch('/api/storage/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, action, path, name }),
    });
    if (!response.ok) {
      const detail = await response.text();
      const message = detail || `USB operation failed with HTTP ${response.status}`;
      if (response.status === 403) throw new AdminAuthorizationError(message);
      throw new Error(message);
    }
  };

  const refreshFiles = async () => {
    const diskInfo = virtualFs.getUsbDiskInfo();
    setUsbDisk(diskInfo);
    setStorageError(null);
    setStorageTruncated(false);

    if (currentPath.startsWith('D:') && diskInfo.status === 'ONLINE') {
      setIsLoadingStorage(true);
      try {
        const logicalPath = currentPath === 'D:' ? '/' : currentPath.slice(2).replaceAll('\\', '/');
        const response = await fetch('/api/storage/list', {
          cache: 'no-store',
          headers: { 'X-USB-Path': encodeHeaderValue(logicalPath) },
        });
        if (!response.ok) {
          throw new Error(`USB listing failed with HTTP ${response.status}`);
        }
        const result = await response.json() as {
          entries: Array<{ name: string; path: string; isFolder: boolean; size: number }>;
          truncated: boolean;
        };
        setNodes(result.entries.map((entry) => ({
          id: entry.path,
          name: entry.name,
          path: `D:${entry.path.slice('/usb'.length).replaceAll('/', '\\')}`,
          isFolder: entry.isFolder,
          size: entry.size,
          modified: '',
          parentPath: currentPath,
          isExecutable: !entry.isFolder && /\.(exe|com|bat)$/i.test(entry.name),
          isImage: !entry.isFolder && /\.(png|jpe?g|gif|bmp|webp|avif|svg|ico)$/i.test(entry.name),
        })));
        setStorageTruncated(result.truncated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setNodes([]);
        setStorageError(message);
      } finally {
        setIsLoadingStorage(false);
      }
      return;
    }


    setNodes(virtualFs.getChildren(currentPath));
    setIsLoadingStorage(false);
  };

  const handleAutoDetectDisk = async () => {
    setIsDetectingDisk(true);
    setDetectNotice(null);
    try {
      const result = await virtualFs.autoDetectDisk();
      setUsbDisk(result);
      setDetectNotice(result.status === 'ONLINE'
        ? `Detected: ${result.vendor} ${result.model} (${result.vendorId}:${result.productId}, ${result.capacityGb.toFixed(2)} GiB)`
        : 'USB detection failed: no mass-storage drive is currently mounted on the ESP32.');
      setTimeout(() => setDetectNotice(null), 3500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDetectNotice(`USB detection failed: ${message}`);
    } finally {
      setIsDetectingDisk(false);
    }
  };

  useEffect(() => {
    const unsub = virtualFs.subscribe(() => {
      void refreshFiles();
    });
    void virtualFs.autoDetectDisk(false).then(() => refreshFiles()).catch(() => refreshFiles());
    return () => unsub();
  }, [currentPath]);

  const navigateTo = (newPath: string) => {
    if (newPath === currentPath) return;
    const newHist = history.slice(0, historyIdx + 1);
    newHist.push(newPath);
    setHistory(newHist);
    setHistoryIdx(newHist.length - 1);
    setCurrentPath(newPath);
    setSelectedNode(null);
    setSearchFilter('');
  };

  const handleBack = () => {
    if (historyIdx > 0) {
      setHistoryIdx(historyIdx - 1);
      setCurrentPath(history[historyIdx - 1]);
      setSelectedNode(null);
    }
  };

  const handleForward = () => {
    if (historyIdx < history.length - 1) {
      setHistoryIdx(historyIdx + 1);
      setCurrentPath(history[historyIdx + 1]);
      setSelectedNode(null);
    }
  };

  const handleUp = () => {
    if (currentPath === 'C:' || currentPath === 'D:' || currentPath === 'This PC') {
      setCurrentPath('This PC');
      return;
    }
    const parts = currentPath.split('\\');
    if (parts.length > 1) {
      parts.pop();
      const parent = parts.join('\\');
      navigateTo(parent.length === 2 && parent.endsWith(':') ? parent : parent);
    } else {
      navigateTo('This PC');
    }
  };

  const handleItemDoubleClick = async (item: FsNode) => {
    if (item.isFolder) {
      navigateTo(item.path);
      return;
    }

    if (item.isExecutable || BINARY_EXTS.test(item.name)) {
      setStorageError('Executable and firmware binary files cannot run on this ESP32 device.');
      return;
    }

    // Images — show inline preview (no app window needed)
    if (item.isImage) {
      if (item.path.startsWith('D:') && usbDisk.status === 'ONLINE') {
        try {
          const logicalPath = item.path.slice(2).replaceAll('\\', '/');
          const response = await fetch('/api/storage/image', {
            cache: 'no-store',
            headers: { 'X-USB-Path': encodeHeaderValue(logicalPath) },
          });
          if (!response.ok) throw new Error(`Image preview unavailable (HTTP ${response.status}).`);
          setImagePreview({ name: item.name, url: URL.createObjectURL(await response.blob()) });
        } catch (error) {
          setStorageError(error instanceof Error ? error.message : String(error));
        }
      } else {
        // For virtual FS images there's no blob URL — open in Media Player as fallback
        onOpenFile('media', { filePath: item.path });
      }
      return;
    }

    // --- File-association routing for everything else ---
    const assoc = getFileAssociation(item.name);

    // Media files → Media Player (no text fetch needed)
    if (assoc.appType === 'media') {
      onOpenFile('media', { filePath: item.path });
      return;
    }

    if (assoc.appType === 'unsupported') {
      setStorageError('Binary files cannot be opened as text in this desktop.');
      return;
    }

    // Text-based files: fetch content from USB when online, else use in-memory content
    if (item.path.startsWith('D:') && usbDisk.status === 'ONLINE') {
      try {
        const logicalPath = item.path.slice(2).replaceAll('\\', '/');
        const response = await fetch('/api/storage/read', {
          cache: 'no-store',
          headers: { 'X-USB-Path': encodeHeaderValue(logicalPath) },
        });
        if (!response.ok) {
          throw new Error(`Preview unavailable (HTTP ${response.status}); only text files can be opened.`);
        }
        const content = await response.text();
        const truncated = response.headers.get('X-Preview-Truncated') === 'true';
        const displayContent = truncated ? `${content}\n\n[Preview truncated at 16 KiB]` : content;

        if (assoc.appType === 'dynamicApp') {
          onOpenFile('dynamicApp', {
            appCode: content,
            appName: item.name.replace(/\.[^/.]+$/, ''),
          });
        } else if (assoc.appType === 'office') {
          onOpenFile('office', { filePath: item.path, initialContent: displayContent });
        } else {
          onOpenFile('notepad', { filePath: item.path, initialContent: displayContent });
        }
      } catch (error) {
        setStorageError(error instanceof Error ? error.message : String(error));
      }
    } else {
      // In-memory virtual FS
      const content = item.content || '';
      if (assoc.appType === 'dynamicApp') {
        onOpenFile('dynamicApp', { appCode: content, appName: item.name.replace(/\.[^/.]+$/, '') });
      } else if (assoc.appType === 'office') {
        onOpenFile('office', { filePath: item.path, initialContent: content });
      } else {
        onOpenFile('notepad', { filePath: item.path, initialContent: content });
      }
    }
  };

  const handleCreateFolder = () => {
    if (!newFolderName.trim()) return;
    if (isPhysicalUsbView) {
      const name = newFolderName.trim();
      const path = currentPath === 'D:' ? '/' : currentPath.slice(2).replaceAll('\\', '/');
      requireAdmin(async (password) => {
        await postStorageAction(password, 'mkdir', path, name);
        setNewFolderName('');
        setIsCreatingFolder(false);
      });
      return;
    }
    if (currentPath.startsWith('C:')) {
      onRequestUac('Create Directory (SPI Flash)', currentPath, () => {
        virtualFs.createFolder(currentPath, newFolderName.trim());
        setNewFolderName('');
        setIsCreatingFolder(false);
        refreshFiles();
      });
    } else {
      virtualFs.createFolder(currentPath, newFolderName.trim());
      setNewFolderName('');
      setIsCreatingFolder(false);
      refreshFiles();
    }
  };

  const handleDelete = () => {
    if (!selectedNode) return;
    if (selectedNode.path === 'C:' || selectedNode.path === 'D:') return;

    if (selectedNode.path.startsWith('D:') && isPhysicalUsbView) {
      const path = selectedNode.path.slice(2).replaceAll('\\', '/');
      requireAdmin(async (password) => {
        await postStorageAction(password, 'delete', path);
        setSelectedNode(null);
      });
      return;
    }

    if (selectedNode.requiresUac || selectedNode.path.includes('\\System') || selectedNode.path.startsWith('C:')) {
      onRequestUac(`Delete ${selectedNode.name}`, selectedNode.path, () => {
        virtualFs.deleteNode(selectedNode.path);
        setSelectedNode(null);
        refreshFiles();
      });
    } else {
      virtualFs.deleteNode(selectedNode.path);
      setSelectedNode(null);
      refreshFiles();
    }
  };

  const handleDownload = async () => {
    if (!selectedNode || selectedNode.isFolder) return;
    
    if (selectedNode.path.startsWith('D:') && isPhysicalUsbView) {
      try {
        setStorageError(null);
        const logicalPath = selectedNode.path.slice(2).replaceAll('\\', '/');
        await storageService.triggerDownload(logicalPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStorageError(message);
      }
      return;
    }
    
    // For virtual FS, create blob from content
    if (selectedNode.content !== undefined) {
      const blob = new Blob([selectedNode.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = selectedNode.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (isPhysicalUsbView) {
      const path = currentPath === 'D:' ? '/' : currentPath.slice(2).replaceAll('\\', '/');
      e.target.value = '';
      requireAdmin(async (password) => {
        const response = await fetch('/api/storage/upload', {
          method: 'POST',
          headers: {
            'X-Admin-Password': password,
            'X-Upload-Path': encodeHeaderValue(path),
            'X-Upload-Name': encodeHeaderValue(file.name),
          },
          body: file,
        });
        if (!response.ok) {
          const detail = await response.text();
          const message = detail || `USB upload failed with HTTP ${response.status}`;
          if (response.status === 403) throw new AdminAuthorizationError(message);
          throw new Error(message);
        }
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string || '';
      const isExe = file.name.toLowerCase().endsWith('.exe') || file.name.toLowerCase().endsWith('.com');
      
      virtualFs.createFile(currentPath, file.name, content, isExe, isExe);
      refreshFiles();
    };
    reader.readAsText(file);
  };

  const filteredNodes = nodes.filter(n => n.name.toLowerCase().includes(searchFilter.toLowerCase()));
  return (
    <div className="flex flex-col h-full bg-[#181d28] text-slate-100 select-none">
      {/* Top Toolbar */}
      <div className="h-11 border-b border-neutral-700/60 px-3 flex items-center justify-between gap-3 bg-[#1d2331]">
        {/* Navigation Arrows */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleBack}
            disabled={historyIdx === 0}
            className="p-1.5 rounded hover:bg-white/10 disabled:opacity-30 text-slate-300"
            title="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleForward}
            disabled={historyIdx >= history.length - 1}
            className="p-1.5 rounded hover:bg-white/10 disabled:opacity-30 text-slate-300"
            title="Forward"
          >
            <ArrowRight className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleUp}
            className="p-1.5 rounded hover:bg-white/10 text-slate-300"
            title="Up one level"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={refreshFiles}
            className="p-1.5 rounded hover:bg-white/10 text-slate-300"
            title="Refresh"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Address Breadcrumb Bar */}
        <div className="flex-1 flex items-center px-3 py-1 bg-neutral-900/80 border border-neutral-700/80 rounded-md text-xs font-mono text-slate-200 overflow-hidden">
          <HardDrive className="w-3.5 h-3.5 mr-2 text-amber-400 shrink-0" />
          <span className="truncate">{currentPath}</span>
        </div>

        {/* Search Bar */}
        <div className="relative w-48 shrink-0">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
          <input
            type="text"
            placeholder="Search folder..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="w-full pl-8 pr-3 py-1 bg-neutral-900/80 border border-neutral-700/80 rounded-md text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {/* Action Strip */}
      <div className="h-10 border-b border-neutral-800 px-4 flex items-center justify-between gap-3 bg-[#161a24] text-xs">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setIsCreatingFolder(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-white/5 hover:bg-white/10 border border-white/10 transition-colors text-slate-200"
          >
            <Plus className="w-3.5 h-3.5 text-blue-400" />
            <span>New Folder</span>
          </button>

          <label className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-white/5 hover:bg-white/10 border border-white/10 transition-colors text-slate-200 cursor-pointer">
            <Upload className="w-3.5 h-3.5 text-emerald-400" />
            <span>Upload File to USB</span>
            <input type="file" onChange={handleFileUpload} className="hidden" />
          </label>

          {selectedNode && !selectedNode.isFolder && (
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 transition-colors"
              title="Download file from USB storage"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>
          )}

          {selectedNode && (
            <button
              type="button"
              onClick={handleDelete}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete</span>
            </button>
          )}
        </div>

        {/* Auto-Detect Flash Drive Button & Status */}
        <div className="flex items-center gap-2">
          {detectNotice && (
            <span className={`text-[11px] px-2 py-0.5 rounded border animate-in fade-in ${
              detectNotice.startsWith('USB detection failed:')
                ? 'text-red-300 bg-red-950/60 border-red-800/60'
                : 'text-emerald-300 bg-emerald-950/60 border-emerald-800/60'
            }`}>
              {detectNotice}
            </span>
          )}

          <button
            type="button"
            onClick={handleAutoDetectDisk}
            disabled={isDetectingDisk}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 font-medium transition-colors disabled:opacity-50"
            title="Interrogate SCSI Read Capacity (10) on USB Host MSC"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isDetectingDisk ? 'animate-spin' : ''}`} />
            <span>{isDetectingDisk ? 'Detecting USB...' : `Auto-Detect (${usbDisk.status === 'ONLINE' ? `${usbDisk.capacityGb.toFixed(2)} GiB` : 'not mounted'})`}</span>
          </button>
        </div>
      </div>

      {/* Main Container: Sidebar + Content Grid */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Tree Sidebar */}
        <div className="w-56 border-r border-neutral-800 bg-[#141822]/80 p-3 space-y-4 overflow-y-auto shrink-0 text-xs">
          <div>
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
              This PC
            </div>
            <div className="space-y-1">
              {/* Drive C */}
              <button
                type="button"
                onClick={() => navigateTo('C:')}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors ${
                  currentPath.startsWith('C:') ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30 font-medium' : 'text-slate-300 hover:bg-white/5'
                }`}
              >
                <Database className="w-4 h-4 text-purple-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">Local Disk (C:)</div>
                  <div className="text-[10px] text-slate-500 font-mono">16MB SPI Flash</div>
                </div>
              </button>

              {/* Drive D: 32GB USB-OTG */}
              <button
                type="button"
                onClick={() => navigateTo('D:')}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors ${
                  currentPath.startsWith('D:') ? 'bg-amber-600/20 text-amber-300 border border-amber-500/30 font-medium' : 'text-slate-300 hover:bg-white/5'
                }`}
              >
                <HardDrive className="w-4 h-4 text-amber-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">USB Drive (D:)</div>
                  <div className="text-[10px] text-amber-400/80 font-mono">
                    {usbDisk.status === 'ONLINE' ? `${usbDisk.capacityGb.toFixed(2)} GiB USB-OTG Host` : 'Not mounted'}
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Quick Access Folders */}
          <div className="pt-2 border-t border-neutral-800/80">
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
              USB Folders
            </div>
            <div className="space-y-0.5">
              {[
                { name: 'Program Files', path: 'D:\\Program Files' },
                { name: 'System32', path: 'D:\\Windows\\System32' },
                { name: 'Users', path: 'D:\\Users' },
                { name: 'Administrator', path: 'D:\\Users\\Administrator' },
              ].map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => navigateTo(f.path)}
                  className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left truncate transition-colors ${
                    currentPath === f.path ? 'bg-white/10 text-white font-medium' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                  }`}
                >
                  <Folder className="w-3.5 h-3.5 text-amber-400/80 shrink-0" />
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Drive Free Space Widget */}
          <div className="pt-3 border-t border-neutral-800 text-[11px] space-y-2">
            <div>
              <div className="flex justify-between text-slate-400 mb-1">
                <span>USB Drive (D:)</span>
                <span className="text-slate-300 font-mono">
                  {usbDisk.usedBytes === null || usbDisk.filesystemTotalBytes === null
                    ? 'Filesystem usage unavailable'
                    : `${(usbDisk.usedBytes / (1024 ** 3)).toFixed(2)} / ${(usbDisk.filesystemTotalBytes / (1024 ** 3)).toFixed(2)} GiB`}
                </span>
              </div>
              <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                <div 
                  style={{ width: `${usbDisk.usedBytes === null || !usbDisk.filesystemTotalBytes ? 0 : Math.min(100, (usbDisk.usedBytes / usbDisk.filesystemTotalBytes) * 100)}%` }} 
                  className="bg-amber-500 h-full rounded-full" 
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-slate-400 mb-1">
                <span>SPI Flash (C:)</span>
                <span className="text-slate-300 font-mono">3.1 / 16 MB</span>
              </div>
              <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                <div className="bg-purple-500 h-full w-[20%]" />
              </div>
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 p-4 overflow-y-auto">
          {isPhysicalUsbView && (
            <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
              USB names are resolved from the ESP32 internal map. Physical USB folders use opaque names; file bytes remain unencrypted.
              {isLoadingStorage && <span className="ml-2">Loading…</span>}
            </div>
          )}
          {storageError && (
            <div className="mb-3 rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-xs text-red-200">
              {storageError}
            </div>
          )}
          {storageTruncated && (
            <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
              Showing the first 128 items in this folder.
            </div>
          )}
          {/* New folder creation prompt */}
          {isCreatingFolder && (
            <div className="mb-4 p-3 bg-[#202738] rounded-lg border border-blue-500/40 flex items-center gap-2">
              <Folder className="w-4 h-4 text-amber-400" />
              <input
                type="text"
                placeholder="Folder name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                autoFocus
                className="flex-1 px-2.5 py-1 text-xs bg-neutral-900 border border-neutral-700 rounded text-white focus:outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={handleCreateFolder}
                className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => setIsCreatingFolder(false)}
                className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 text-slate-300 rounded text-xs"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Files Grid View */}
          {filteredNodes.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-2">
              <Folder className="w-12 h-12 text-slate-600 stroke-[1.5]" />
              <p className="text-sm">{isLoadingStorage ? 'Loading folder…' : storageError ? 'Unable to list this folder.' : 'This folder is empty.'}</p>
              <p className="text-xs text-slate-600">Create a folder or upload a file using the toolbar above.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
              {filteredNodes.map((item) => {
                const isSelected = selectedNode?.id === item.id;
                return (
                  <div
                    key={item.id}
                    onClick={() => setSelectedNode(item)}
                    onDoubleClick={() => void handleItemDoubleClick(item)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelectedNode(item);
                      setContextMenu({
                        item,
                        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 168)),
                        y: Math.max(8, Math.min(event.clientY, window.innerHeight - 56)),
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleItemDoubleClick(item);
                    }}
                    role="button"
                    tabIndex={0}
                    className={`flex flex-col items-center p-3 rounded-xl border cursor-pointer transition-all text-center group ${
                      isSelected
                        ? 'bg-blue-600/20 border-blue-500/50 shadow-sm'
                        : 'bg-neutral-900/40 border-neutral-800/80 hover:bg-neutral-800/50 hover:border-neutral-700'
                    }`}
                  >
                    {/* Item Icon */}
                    <div className="relative mb-2">
                      <FileTypeIcon item={item} />

                      {/* UAC Shield indicator on executable */}
                      {item.requiresUac && (
                        <div className="absolute -top-1 -right-1 bg-amber-500 rounded-full p-0.5 border border-neutral-900 shadow">
                          <ShieldAlert className="w-3 h-3 text-black" />
                        </div>
                      )}
                    </div>

                    {/* Name */}
                    <span className="text-xs font-medium text-slate-200 group-hover:text-white line-clamp-2 w-full break-all">
                      {item.name}
                    </span>

                    {/* Meta: size + "opens with" hint */}
                    <span className="text-[10px] text-slate-500 mt-1 font-mono">
                      {item.isFolder ? 'Folder' : `${(item.size / 1024).toFixed(1)} KB`}
                    </span>
                    {!item.isFolder && (
                      <span className="text-[9px] text-slate-600 group-hover:text-blue-400 transition-colors mt-0.5 leading-tight">
                        {item.isExecutable || BINARY_EXTS.test(item.name)
                          ? 'Execution not supported'
                          : item.isImage
                            ? 'Preview'
                            : (() => {
                                const a = getFileAssociation(item.name).appType;
                                const labels: Record<string, string> = {
                                  media: 'Opens with Media Player',
                                  office: 'Opens with Office Suite',
                                  unsupported: 'Open not supported',
                                  dynamicApp: 'Opens as Web App',
                                  notepad: 'Opens with Notepad',
                                };
                                return labels[a] ?? 'Opens with Notepad';
                              })()}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          role="menu"
          aria-label={`${contextMenu.item.name} actions`}
          className="fixed z-[10000] min-w-40 rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-md px-3 py-2 text-left text-sm text-slate-100 hover:bg-blue-600 focus:bg-blue-600 focus:outline-none"
            onClick={() => {
              const item = contextMenu.item;
              setContextMenu(null);
              void handleItemDoubleClick(item);
            }}
          >
            Open
          </button>
          {!contextMenu.item.isFolder && (
            <button
              type="button"
              role="menuitem"
              className="w-full rounded-md px-3 py-2 text-left text-sm text-slate-100 hover:bg-emerald-600 focus:bg-emerald-600 focus:outline-none flex items-center gap-2"
              onClick={() => {
                setContextMenu(null);
                void handleDownload();
              }}
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>
          )}
        </div>
      )}

      {imagePreview && (
        <div
          className="fixed inset-0 z-[9500] flex flex-col items-center justify-center bg-black/85 p-4"
          onClick={() => setImagePreview(null)}
        >
          <div className="mb-3 flex w-full max-w-5xl items-center justify-between text-sm text-white">
            <span className="truncate pr-4">{imagePreview.name}</span>
            <button
              type="button"
              className="rounded bg-neutral-800 px-3 py-1.5 hover:bg-neutral-700"
              onClick={() => setImagePreview(null)}
            >
              Close
            </button>
          </div>
          <img
            src={imagePreview.url}
            alt={imagePreview.name}
            className="max-h-[80vh] max-w-full object-contain"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}

      {pendingAdminOperation && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-4">
          <form
            className="w-full max-w-sm rounded-xl border border-neutral-700 bg-[#202020] p-5 shadow-2xl"
            onSubmit={(event) => {
              event.preventDefault();
              void runAdminOperation();
            }}
          >
            <h2 className="text-base font-semibold text-white">Administrator permission required</h2>
            <p className="mt-2 text-xs text-slate-300">
              Enter an administrator password to change files on the USB drive. It will be remembered in memory until this page is closed or reloaded.
            </p>
            <input
              type="password"
              autoFocus
              value={adminPassword}
              onChange={(event) => setAdminPassword(event.target.value)}
              className="mt-4 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white"
              placeholder="Administrator password"
              aria-label="Administrator password"
            />
            {storageError && <p className="mt-2 text-xs text-red-300">{storageError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingAdminOperation(null)}
                disabled={isAdminOperationRunning}
                className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-slate-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isAdminOperationRunning || !adminPassword}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              >
                {isAdminOperationRunning ? 'Working…' : 'Continue'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Status Bar */}
      <div className="h-6 border-t border-neutral-800 px-4 bg-[#141822] flex items-center justify-between text-[11px] text-slate-400">
        <div>
          <span>{filteredNodes.length} items</span>
          {selectedNode && (
            <span className="ml-3 text-slate-300">
              Selected: <span className="text-blue-300 font-mono">{selectedNode.name}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span>USB-OTG Host</span>
          <span>·</span>
          <span>FAT32 Long File Names</span>
        </div>
      </div>
    </div>
  );
};
