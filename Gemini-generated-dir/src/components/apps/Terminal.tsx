import React, { useEffect, useRef, useState } from 'react';
import { Terminal as TerminalIcon, Shield } from 'lucide-react';
import { virtualFs } from '../../services/virtualFs';
import { authService } from '../../services/authService';
import { FirmwareSystemSnapshot, WindowAppType } from '../../types';

interface TerminalProps {
  onOpenFile?: (appType: WindowAppType, data?: unknown) => void;
  onRequestUac?: (appName: string, filePath: string, action: () => void) => void;
}

interface UsbEntry {
  name: string;
  path: string;
  isFolder: boolean;
  size: number;
}

type AuthorizedMutation = (password: string) => Promise<string>;

const MAX_COMMAND_LENGTH = 512;
const MAX_TERMINAL_LINES = 500;
const MAX_TEXT_WRITE_BYTES = 16 * 1024;

const encodeHeaderValue = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const tokenize = (command: string): string[] => {
  const tokens = command.match(/"[^"]*"|\S+/g) ?? [];
  return tokens.map((token) =>
    token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token,
  );
};

const normalizePath = (input: string, currentDir: string): string => {
  const requested = input.replaceAll('/', '\\');
  const absolute = /^[a-zA-Z]:/.test(requested)
    ? requested
    : requested.startsWith('\\')
      ? `${currentDir.slice(0, 2)}${requested}`
      : `${currentDir}\\${requested}`;
  const drive = absolute.slice(0, 2).toUpperCase();
  if (drive !== 'C:' && drive !== 'D:') throw new Error('Only C: and D: drives are available.');

  const segments: string[] = [];
  for (const segment of absolute.slice(2).split('\\')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    if (/[\x00-\x1f<>:"|?*]/.test(segment)) throw new Error('The path contains an invalid character.');
    segments.push(segment);
  }
  const normalized = `${drive}${segments.length ? `\\${segments.join('\\')}` : ''}`;
  if (new TextEncoder().encode(normalized).length > 255) throw new Error('The path exceeds the 255-byte storage limit.');
  return normalized;
};

const usbLogicalPath = (windowsPath: string): string =>
  windowsPath.slice(2).replaceAll('\\', '/') || '/';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

const getHttpError = async (response: Response, action: string): Promise<Error> => {
  const detail = (await response.text()).trim();
  return new Error(detail || `${action} failed with HTTP ${response.status}.`);
};

export const TerminalApp: React.FC<TerminalProps> = ({ onOpenFile, onRequestUac }) => {
  const [currentDir, setCurrentDir] = useState('D:\\Windows\\System32');
  const [inputVal, setInputVal] = useState('');
  const [history, setHistory] = useState<string[]>([
    'Microsoft Windows [Version 10.0.22631.3007] - ESP32-S3 WebOS Edition',
    '(c) Microsoft Corporation & Espressif Systems. All rights reserved.',
    '',
    "Type 'help' to view available commands.",
    '',
  ]);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [pendingMutation, setPendingMutation] = useState<AuthorizedMutation | null>(null);
  const [mutationRunning, setMutationRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, isRunning, pendingMutation]);

  const appendOutput = (lines: string[]) => {
    setHistory((previous) => [...previous, ...lines].slice(-MAX_TERMINAL_LINES));
  };

  const appendOutputSafely = (lines: string[]) => {
    appendOutput(lines.flatMap((line) => {
      if (line.length <= 4096) return [line];
      return [`${line.slice(0, 4096)}… [line truncated]`];
    }));
  };

  const getDirectoryEntries = async (path: string): Promise<UsbEntry[]> => {
    if (path.startsWith('D:') && virtualFs.getUsbDiskInfo().status === 'ONLINE') {
      const response = await fetch('/api/storage/list', {
        cache: 'no-store',
        headers: { 'X-USB-Path': encodeHeaderValue(usbLogicalPath(path)) },
      });
      if (!response.ok) throw await getHttpError(response, 'USB directory listing');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !Array.isArray((result as { entries?: unknown }).entries)) {
        throw new Error('The ESP32 returned an invalid USB directory listing.');
      }
      return (result as { entries: UsbEntry[] }).entries;
    }
    return virtualFs.getChildren(path).map((node) => ({
      name: node.name,
      path: node.path,
      isFolder: node.isFolder,
      size: node.size,
    }));
  };

  const readTextFile = async (path: string): Promise<string> => {
    if (path.startsWith('D:') && virtualFs.getUsbDiskInfo().status === 'ONLINE') {
      const response = await fetch('/api/storage/read', {
        cache: 'no-store',
        headers: { 'X-USB-Path': encodeHeaderValue(usbLogicalPath(path)) },
      });
      if (!response.ok) throw await getHttpError(response, 'File read');
      const content = await response.text();
      return response.headers.get('X-Preview-Truncated') === 'true'
        ? `${content}\n[Output truncated at 16 KiB]`
        : content;
    }
    const node = virtualFs.getNodeByPath(path);
    if (!node || node.isFolder) throw new Error(`The system cannot find the file specified: ${path}`);
    return node.content || '[File is empty or has no text content]';
  };

  const postUsbMutation = async (
    password: string,
    action: 'mkdir' | 'delete',
    path: string,
    name?: string,
  ): Promise<void> => {
    const response = await fetch('/api/storage/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, action, path: usbLogicalPath(path), name }),
    });
    if (!response.ok) throw await getHttpError(response, `USB ${action}`);
  };

  const uploadUsbText = async (password: string, path: string, content: string): Promise<void> => {
    const slash = path.lastIndexOf('\\');
    const parent = slash <= 2 ? 'D:' : path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (!name || name === '.' || name === '..') throw new Error('Invalid destination filename.');
    if (new Blob([content]).size > MAX_TEXT_WRITE_BYTES) {
      throw new Error(`Text writes are limited to ${MAX_TEXT_WRITE_BYTES / 1024} KiB.`);
    }
    const response = await fetch('/api/storage/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Admin-Password': password,
        'X-Upload-Path': encodeHeaderValue(usbLogicalPath(parent)),
        'X-Upload-Name': encodeHeaderValue(name),
      },
      body: content,
    });
    if (!response.ok) throw await getHttpError(response, 'USB text write');
  };

  const askForAdminPassword = (operation: AuthorizedMutation) => {
    setPendingMutation(() => operation);
    setAdminPassword('');
    window.setTimeout(() => passwordRef.current?.focus(), 0);
  };

  const submitAdminPassword = async () => {
    if (!pendingMutation || mutationRunning) return;
    setMutationRunning(true);
    try {
      const result = await pendingMutation(adminPassword);
      appendOutput([result]);
      setPendingMutation(null);
      setAdminPassword('');
    } catch (error) {
      appendOutput([`Access denied or operation failed: ${error instanceof Error ? error.message : String(error)}`]);
      setAdminPassword('');
      window.setTimeout(() => passwordRef.current?.focus(), 0);
    } finally {
      setMutationRunning(false);
    }
  };

  const handleCommand = async (commandLine: string) => {
    const raw = commandLine.trim();
    if (!raw) {
      appendOutput([`${currentDir}>`]);
      return;
    }
    if (raw.length > MAX_COMMAND_LENGTH) {
      appendOutput([`Command exceeds the ${MAX_COMMAND_LENGTH}-character limit.`]);
      return;
    }
    appendOutput([`${currentDir}> ${raw}`]);
    setCommandHistory((previous) => [...previous, raw].slice(-100));
    setHistoryIndex(null);

    const tokens = tokenize(raw);
    const cmd = (tokens.shift() ?? '').toLowerCase();
    const currentUser = authService.getCurrentUser();
    const output: string[] = [];

    try {
      switch (cmd) {
        case 'help':
          output.push(
            'Available Commands:',
            '  DIR [path]             List the live USB folder or local virtual files',
            '  CD <path>               Change drive/folder; CD .. moves up',
            '  TYPE <file>             Read text (USB previews are limited to 16 KiB)',
            '  MD|MKDIR <folder>       Create a folder (USB requires admin password)',
            '  DEL <file-or-folder>    Delete an item (USB requires admin password)',
            '  ECHO <text> [> file]    Print text or write a text file',
            '  MEM|PSRAM               Show live ESP32 heap and PSRAM stats',
            '  SYSTEMINFO              Show live device, Wi-Fi and storage status',
            '  IPCONFIG                Show live Wi-Fi address information',
            '  WHOAMI                  Show the signed-in desktop user',
            '  UAC                     Show the current UAC policy',
            '  START <app>             Open Explorer, Notepad, Settings, Media Player, or Task Manager',
            '  CLS                     Clear the console',
            '  VER, DATE, TIME         Show version or current browser time',
            '  YT-DLP / ANI-CLI        Host-only utilities; see notes below',
          );
          break;

        case 'cls':
        case 'clear':
          setHistory([]);
          return;

        case 'ver':
          output.push(
            'Windows 11 WebOS on ESP32-S3 N16R8',
            'ESP-IDF firmware · Xtensa LX7 · USB MSC Host',
            'CMD executes only the explicitly implemented desktop and ESP32 API commands.',
          );
          break;

        case 'date':
          output.push(new Date().toLocaleDateString());
          break;

        case 'time':
          output.push(new Date().toLocaleTimeString());
          break;

        case 'whoami':
          output.push(
            `ESP32-S3\\${currentUser.username} (${currentUser.displayName})`,
            `Privilege: ${currentUser.isAdmin ? 'BUILTIN\\Administrators' : 'BUILTIN\\Users'}`,
          );
          break;

        case 'uac':
          output.push(
            `Current User Account Control Policy: Level ${currentUser.uacLevel}`,
            '  - Level 3: Always notify and prompt for credentials',
            '  - Level 2: Default - Prompt for consent with Dim Desktop',
            '  - Level 1: Notify without dimming',
            '  - Level 0: Disabled (Never notify)',
          );
          break;

        case 'mem':
        case 'psram':
        case 'systeminfo':
        case 'ipconfig': {
          const response = await fetch('/api/system/stats', { cache: 'no-store' });
          if (!response.ok) throw await getHttpError(response, 'Live system query');
          const stats = await response.json() as FirmwareSystemSnapshot;
          if (cmd === 'ipconfig') {
            output.push(
              'ESP32-S3 Network Configuration',
              `Wi-Fi mode: ${stats.wifiMode}`,
              `Station: ${stats.wifiStationConnected ? `${stats.wifiStationSsid ?? 'connected'} (${stats.wifiStationIp ?? 'IP unavailable'})` : 'not connected'}`,
              `Access point: ${stats.wifiApSsid ?? 'unavailable'} (${stats.wifiApIp ?? 'IP unavailable'})`,
              `Connected AP clients: ${stats.wifiApClientCount ?? 'unavailable'}`,
            );
          } else if (cmd === 'systeminfo') {
            output.push(
              'ESP32-S3 WebOS System Information',
              `Chip: ${stats.chipModel} revision ${stats.chipRevision}`,
              `CPU: ${stats.cpuCores} core(s), ${(stats.cpuFrequencyHz / 1_000_000).toFixed(0)} MHz`,
              `Uptime: ${Math.floor(stats.uptimeSeconds)} seconds`,
              `Flash: ${stats.flashSizeValid && stats.flashSizeBytes !== null ? formatBytes(stats.flashSizeBytes) : 'unavailable'}`,
              `PSRAM: ${formatBytes(stats.psramFreeBytes)} free of ${formatBytes(stats.psramTotalBytes)}`,
              `Internal heap: ${formatBytes(stats.internalHeapFreeBytes)} free of ${formatBytes(stats.internalHeapTotalBytes)}`,
              `USB storage: ${stats.usbMounted ? `${stats.usbTotalGb.toFixed(2)} GiB mounted` : 'not mounted'}`,
              `Wi-Fi: ${stats.wifiMode}; station ${stats.wifiStationConnected ? 'connected' : 'disconnected'}`,
            );
          } else {
            output.push(
              'Live ESP32 Memory Status',
              `PSRAM: ${formatBytes(stats.psramFreeBytes)} free / ${formatBytes(stats.psramTotalBytes)} total`,
              `PSRAM minimum free: ${formatBytes(stats.psramMinimumFreeBytes)}`,
              `Largest PSRAM block: ${formatBytes(stats.psramLargestBlockBytes)}`,
              `Internal heap: ${formatBytes(stats.internalHeapFreeBytes)} free / ${formatBytes(stats.internalHeapTotalBytes)} total`,
              `Largest internal block: ${formatBytes(stats.internalHeapLargestBlockBytes)}`,
            );
          }
          break;
        }

        case 'dir':
        case 'ls': {
          const targetPath = tokens[0] ? normalizePath(tokens[0], currentDir) : currentDir;
          const entries = await getDirectoryEntries(targetPath);
          let fileCount = 0;
          let totalSize = 0;
          output.push(` Directory of ${targetPath}`, '');
          for (const entry of entries) {
            if (entry.isFolder) {
              output.push(`<DIR>          ${entry.name}`);
            } else {
              fileCount++;
              totalSize += entry.size;
              output.push(`${formatBytes(entry.size).padStart(12, ' ')} ${entry.name}`);
            }
          }
          output.push(
            '',
            `               ${fileCount} File(s)     ${formatBytes(totalSize)}`,
            `               ${entries.length - fileCount} Dir(s)`,
          );
          break;
        }

        case 'cd':
        case 'chdir': {
          if (!tokens[0]) {
            output.push(currentDir);
            break;
          }
          const targetPath = normalizePath(tokens[0], currentDir);
          const target = virtualFs.getNodeByPath(targetPath);
          const existsInVirtualFs = target?.isFolder === true;
          if (targetPath.startsWith('D:') && virtualFs.getUsbDiskInfo().status === 'ONLINE') {
            await getDirectoryEntries(targetPath);
            setCurrentDir(targetPath);
          } else if (existsInVirtualFs) {
            setCurrentDir(targetPath);
          } else {
            output.push(`The system cannot find the path specified: ${tokens[0]}`);
          }
          break;
        }

        case 'type':
        case 'cat': {
          if (!tokens[0]) {
            output.push('Usage: TYPE <filename>');
            break;
          }
          const targetPath = normalizePath(tokens.join(' '), currentDir);
          const content = await readTextFile(targetPath);
          output.push(...(content ? content.split(/\r?\n/) : ['[File is empty]']));
          break;
        }

        case 'md':
        case 'mkdir': {
          if (!tokens[0]) {
            output.push('Usage: MKDIR <folder-name>');
            break;
          }
          if (tokens.length !== 1 || /[\\/:*?"<>|]/.test(tokens[0]) || tokens[0] === '.' || tokens[0] === '..') {
            output.push('Invalid folder name. Use one name without path separators or reserved characters.');
            break;
          }
          if (currentDir.startsWith('D:') && virtualFs.getUsbDiskInfo().status === 'ONLINE') {
            const folderName = tokens[0];
            askForAdminPassword(async (password) => {
              await postUsbMutation(password, 'mkdir', currentDir, folderName);
              return `Created USB directory: ${folderName}`;
            });
            output.push('Administrator password required to create a folder on the USB drive.');
          } else {
            virtualFs.createFolder(currentDir, tokens[0]);
            output.push(`Created directory: ${tokens[0]}`);
          }
          break;
        }

        case 'del':
        case 'erase':
        case 'rmdir': {
          if (!tokens[0]) {
            output.push('Usage: DEL <file-or-folder>');
            break;
          }
          const targetPath = normalizePath(tokens.join(' '), currentDir);
          if (targetPath === 'C:' || targetPath === 'D:') {
            output.push('Access denied. Drive roots cannot be deleted.');
            break;
          }
          if (targetPath.startsWith('D:') && virtualFs.getUsbDiskInfo().status === 'ONLINE') {
            askForAdminPassword(async (password) => {
              await postUsbMutation(password, 'delete', targetPath);
              return `Deleted USB item: ${targetPath}`;
            });
            output.push('Administrator password required to delete from the USB drive.');
          } else if (virtualFs.deleteNode(targetPath)) {
            output.push(`Deleted: ${targetPath}`);
          } else {
            output.push(`Could Not Find ${targetPath}`);
          }
          break;
        }

        case 'echo': {
          const redirectIndex = tokens.indexOf('>');
          if (redirectIndex < 0) {
            output.push(tokens.join(' '));
            break;
          }
          if (redirectIndex !== tokens.length - 2 || redirectIndex === 0) {
            output.push('Usage: ECHO <text> > <filename>');
            break;
          }
          const content = tokens.slice(0, redirectIndex).join(' ');
          const targetPath = normalizePath(tokens[redirectIndex + 1], currentDir);
          if (targetPath === 'C:' || targetPath === 'D:') {
            output.push('Access denied. A drive root is not a file.');
            break;
          }
          if (targetPath.startsWith('D:') && virtualFs.getUsbDiskInfo().status === 'ONLINE') {
            askForAdminPassword(async (password) => {
              await uploadUsbText(password, targetPath, content);
              return `Wrote ${new Blob([content]).size} bytes to ${targetPath}`;
            });
            output.push('Administrator password required to write to the USB drive.');
          } else {
            const slash = targetPath.lastIndexOf('\\');
            const parentPath = slash <= 2 ? targetPath.slice(0, 2) : targetPath.slice(0, slash);
            const name = targetPath.slice(slash + 1);
            const parent = virtualFs.getNodeByPath(parentPath);
            if (!parent?.isFolder) {
              output.push(`The system cannot find the path specified: ${parentPath}`);
            } else {
              virtualFs.createFile(parentPath, name, content);
              output.push(`Wrote ${new Blob([content]).size} bytes to ${targetPath}`);
            }
          }
          break;
        }

        case 'run':
          output.push('Executable programs are not supported on this ESP32 device.');
          break;

        case 'start': {
          const target = tokens.join(' ');
          if (!target) {
            output.push('Usage: START <app-name>');
            break;
          }
          if (/\.(exe|com)$/i.test(target)) {
            output.push('Executable programs are not supported on this ESP32 device.');
            break;
          }
          const appNames: Record<string, WindowAppType> = {
            explorer: 'explorer',
            'file explorer': 'explorer',
            notepad: 'notepad',
            settings: 'settings',
            'task manager': 'taskmgr',
            taskmgr: 'taskmgr',
            terminal: 'terminal',
            'media player': 'media',
            calculator: 'calculator',
          };
          const app = appNames[target.toLowerCase()];
          if (app) {
            onOpenFile?.(app);
            output.push(`Starting ${target}...`);
          } else {
            output.push(`The app '${target}' is not installed in this desktop.`);
          }
          break;
        }

        case 'yt-dlp':
        case 'yt-dlp.exe':
          output.push(
            'yt-dlp is not installed in this ESP32 WebOS terminal.',
            'yt-dlp is a host-side Python application and cannot run on ESP-IDF firmware.',
            'Use a trusted Windows PC to install yt-dlp, or download media separately and copy it into the USB drive.',
          );
          break;

        case 'ani-cli':
          output.push(
            'ani-cli is not available in this ESP32 WebOS terminal.',
            'ani-cli is a Unix shell script that depends on host tools such as curl, fzf, and a media player.',
            'This ESP32 firmware has no Unix shell or package manager; use a compatible PC for this tool.',
          );
          break;

        default: {
          if (/\.(exe|com)$/i.test(cmd)) {
            output.push('Executable programs are not supported on this ESP32 device.');
          } else {
            output.push(`'${cmd}' is not recognized as an internal or external command.`);
          }
          break;
        }
      }
    } catch (error) {
      output.push(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    appendOutputSafely(output);
  };

  const submitCommand = async () => {
    if (isRunning || pendingMutation) return;
    setIsRunning(true);
    try {
      await handleCommand(inputVal);
    } finally {
      setInputVal('');
      setIsRunning(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (pendingMutation) void submitAdminPassword();
      else void submitCommand();
      return;
    }
    if (event.key === 'ArrowUp' && !pendingMutation) {
      event.preventDefault();
      setHistoryIndex((previous) => {
        const next = previous === null ? commandHistory.length - 1 : Math.max(0, previous - 1);
        setInputVal(commandHistory[next] ?? '');
        return next;
      });
    } else if (event.key === 'ArrowDown' && !pendingMutation) {
      event.preventDefault();
      setHistoryIndex((previous) => {
        const next = previous === null ? null : previous + 1 >= commandHistory.length ? null : previous + 1;
        setInputVal(next === null ? '' : commandHistory[next] ?? '');
        return next;
      });
    }
  };

  return (
    <div
      className="flex flex-col h-full bg-[#0c0c0c] text-[#cccccc] font-mono text-xs select-text p-4 overflow-hidden"
      onClick={() => (pendingMutation ? passwordRef.current : inputRef.current)?.focus()}
    >
      <div className="flex-1 overflow-y-auto space-y-1">
        {history.map((line, idx) => (
          <div key={idx} className="whitespace-pre-wrap break-words leading-relaxed">
            {line}
          </div>
        ))}
        {isRunning && <div className="text-cyan-300">Working…</div>}

        {pendingMutation ? (
          <form
            className="flex items-center gap-2 pt-2 text-amber-300"
            onSubmit={(event) => {
              event.preventDefault();
              void submitAdminPassword();
            }}
          >
            <Shield className="h-4 w-4 shrink-0" />
            <label htmlFor="cmd-admin-password">Administrator password:</label>
            <input
              id="cmd-admin-password"
              ref={passwordRef}
              type="password"
              value={adminPassword}
              onChange={(event) => setAdminPassword(event.target.value)}
              autoComplete="current-password"
              disabled={mutationRunning}
              className="min-w-0 flex-1 bg-transparent text-white focus:outline-none"
            />
            <button type="submit" disabled={mutationRunning} className="text-cyan-300 disabled:opacity-50">
              {mutationRunning ? 'Working…' : 'Enter'}
            </button>
            <button
              type="button"
              disabled={mutationRunning}
              onClick={() => {
                setPendingMutation(null);
                setAdminPassword('');
                appendOutput(['Operation cancelled.']);
              }}
              className="text-slate-400 disabled:opacity-50"
            >
              Cancel
            </button>
          </form>
        ) : (
          <div className="flex items-center gap-1.5 pt-1">
            <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span className="shrink-0 text-white font-medium select-none">{currentDir}&gt;</span>
            <input
              ref={inputRef}
              type="text"
              value={inputVal}
              onChange={(event) => setInputVal(event.target.value.slice(0, MAX_COMMAND_LENGTH))}
              onKeyDown={handleKeyDown}
              autoFocus
              maxLength={MAX_COMMAND_LENGTH}
              disabled={isRunning}
              aria-label="Command"
              className="min-w-0 flex-1 bg-transparent text-white focus:outline-none border-none p-0 font-mono text-xs caret-white disabled:opacity-60"
            />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};
