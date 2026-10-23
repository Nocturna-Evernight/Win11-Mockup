import React, { useEffect, useRef, useState } from 'react';
import { Download, FileSpreadsheet, FileText, Presentation, Plus, Save } from 'lucide-react';
import { AccountOfficeState, authService } from '../../services/authService';

type OfficeTab = 'document' | 'spreadsheet' | 'slides';

interface Slide {
  title: string;
  body: string;
}

const OFFICE_KEY = 'esp32-webos-office-data-v1';
const ROWS = 8;
const COLS = 6;
const EMPTY_GRID = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => ''));

const cellCoordinates = (address: string): [number, number] | null => {
  const match = /^([A-F])([1-8])$/i.exec(address);
  return match ? [Number(match[2]) - 1, match[1].toUpperCase().charCodeAt(0) - 65] : null;
};

const evaluateCell = (grid: string[][], row: number, column: number, visiting = new Set<string>()): number => {
  const key = `${columnName(column)}${row + 1}`;
  if (visiting.has(key)) throw new Error('#CYCLE!');
  const raw = grid[row]?.[column] ?? '';
  if (!raw.startsWith('=')) {
    const value = Number(raw);
    if (!raw.trim()) return 0;
    if (!Number.isFinite(value)) throw new Error('#VALUE!');
    return value;
  }

  visiting.add(key);
  try {
    const expression = raw.slice(1).replace(/\s/g, '').toUpperCase();
    const tokens = expression.match(/AVERAGE|SUM|AVG|MIN|MAX|[A-F][1-8]|\d+(?:\.\d*)?|\.\d+|[()+*/:-]/g) ?? [];
    if (tokens.join('') !== expression) throw new Error('#VALUE!');
    let index = 0;

    const factor = (): number => {
      const token = tokens[index++];
      if (token === '+') return factor();
      if (token === '-') return -factor();
      if (token === '(') {
        const value = expressionValue();
        if (tokens[index++] !== ')') throw new Error('#VALUE!');
        return value;
      }
      if (['SUM', 'AVG', 'AVERAGE', 'MIN', 'MAX'].includes(token)) {
        if (tokens[index++] !== '(') throw new Error('#VALUE!');
        const firstAddress = tokens[index++];
        if (!cellCoordinates(firstAddress)) throw new Error('#VALUE!');
        let lastAddress = firstAddress;
        if (tokens[index] === ':') {
          index++;
          lastAddress = tokens[index++];
          if (!cellCoordinates(lastAddress)) throw new Error('#VALUE!');
        }
        if (tokens[index++] !== ')') throw new Error('#VALUE!');
        const [firstRow, firstColumn] = cellCoordinates(firstAddress)!;
        const [lastRow, lastColumn] = cellCoordinates(lastAddress)!;
        const values: number[] = [];
        for (let r = Math.min(firstRow, lastRow); r <= Math.max(firstRow, lastRow); r++) {
          for (let c = Math.min(firstColumn, lastColumn); c <= Math.max(firstColumn, lastColumn); c++) {
            values.push(evaluateCell(grid, r, c, visiting));
          }
        }
        if (token === 'SUM') return values.reduce((sum, value) => sum + value, 0);
        if (token === 'MIN') return Math.min(...values);
        if (token === 'MAX') return Math.max(...values);
        return values.reduce((sum, value) => sum + value, 0) / values.length;
      }
      const coordinates = cellCoordinates(token);
      if (coordinates) return evaluateCell(grid, coordinates[0], coordinates[1], visiting);
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error('#VALUE!');
      return value;
    };

    const term = (): number => {
      let value = factor();
      while (tokens[index] === '*' || tokens[index] === '/') {
        const operation = tokens[index++];
        const next = factor();
        if (operation === '/' && next === 0) throw new Error('#DIV/0!');
        value = operation === '*' ? value * next : value / next;
      }
      return value;
    };

    const expressionValue = (): number => {
      let value = term();
      while (tokens[index] === '+' || tokens[index] === '-') {
        const operation = tokens[index++];
        const next = term();
        value = operation === '+' ? value + next : value - next;
      }
      return value;
    };

    const result = expressionValue();
    if (index !== tokens.length || !Number.isFinite(result)) throw new Error('#VALUE!');
    return result;
  } finally {
    visiting.delete(key);
  }
};

const displayCell = (grid: string[][], row: number, column: number): string => {
  const raw = grid[row]?.[column] ?? '';
  if (!raw.startsWith('=')) return raw;
  try {
    return String(Number(evaluateCell(grid, row, column).toPrecision(12)));
  } catch (cause) {
    return cause instanceof Error ? cause.message : '#VALUE!';
  }
};

const downloadText = (name: string, contents: string, type: string) => {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const columnName = (index: number) => String.fromCharCode(65 + index);

export const OfficeSuiteApp: React.FC<{ userId: string }> = ({ userId }) => {
  const [tab, setTab] = useState<OfficeTab>('document');
  const [documentTitle, setDocumentTitle] = useState('Untitled document');
  const [documentBody, setDocumentBody] = useState('');
  const [grid, setGrid] = useState<string[][]>(EMPTY_GRID);
  const [slides, setSlides] = useState<Slide[]>([{ title: 'Title', body: 'Add your presentation text here.' }]);
  const [activeSlide, setActiveSlide] = useState(0);
  const [saveNotice, setSaveNotice] = useState('Loading account documents…');
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const latestOfficeState = useRef<AccountOfficeState | null>(null);

  useEffect(() => {
    try {
      const sharedState = authService.getDesktopState(userId)?.office;
      const stored = sharedState ? JSON.stringify(sharedState) : localStorage.getItem(OFFICE_KEY);
      if (!stored) return;
      const data = JSON.parse(stored) as Partial<AccountOfficeState> & {
        documentTitle?: string;
        documentBody?: string;
        grid?: string[][];
        slides?: Slide[];
      };
      if (typeof data.documentTitle === 'string') setDocumentTitle(data.documentTitle);
      if (typeof data.documentBody === 'string') setDocumentBody(data.documentBody);
      if (Array.isArray(data.grid) && data.grid.every((row) => Array.isArray(row) && row.length === COLS)) {
        setGrid(data.grid);
      }
      if (Array.isArray(data.slides) && data.slides.length && data.slides.every((slide) =>
        typeof slide.title === 'string' && typeof slide.body === 'string')) {
        setSlides(data.slides);
      }
    } catch (error) {
      console.error('Could not load saved office data:', error);
      setSaveNotice('Could not load saved account documents.');
    } finally {
      setLoaded(true);
    }
  }, [userId]);

  useEffect(() => () => {
    if (saveTimer.current === null) return;
    window.clearTimeout(saveTimer.current);
    const pendingState = latestOfficeState.current;
    if (pendingState) {
      void authService.updateDesktopState(userId, { office: pendingState });
    }
  }, [userId]);

  useEffect(() => {
    if (!loaded) return;
    const data: AccountOfficeState = { documentTitle, documentBody, grid, slides };
    latestOfficeState.current = data;
    try {
      localStorage.setItem(OFFICE_KEY, JSON.stringify(data));
      setSaveNotice('Saved locally; syncing to the ESP32…');
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        void authService.updateDesktopState(userId, { office: data }).then((savedToDevice) => {
          setSaveNotice(savedToDevice
            ? 'Saved to this account on the ESP32.'
            : 'Saved in this browser only; ESP32 account sync failed.');
        });
      }, 500);
    } catch (error) {
      console.error('Could not save office data:', error);
      setSaveNotice('Could not save: browser storage may be full or disabled.');
    }
  }, [documentTitle, documentBody, grid, slides, loaded, userId]);

  const updateCell = (row: number, column: number, value: string) => {
    setGrid((previous) => previous.map((cells, rowIndex) =>
      rowIndex === row ? cells.map((cell, columnIndex) => columnIndex === column ? value : cell) : cells));
  };

  const updateSlide = (field: keyof Slide, value: string) => {
    setSlides((previous) => previous.map((slide, index) =>
      index === activeSlide ? { ...slide, [field]: value } : slide));
  };

  const tabs: { id: OfficeTab; label: string; icon: React.ReactNode }[] = [
    { id: 'document', label: 'Document', icon: <FileText className="h-4 w-4" /> },
    { id: 'spreadsheet', label: 'Spreadsheet', icon: <FileSpreadsheet className="h-4 w-4" /> },
    { id: 'slides', label: 'Slides', icon: <Presentation className="h-4 w-4" /> },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#111722] text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#171e2b] px-3 py-2">
        <div className="flex gap-1">
          {tabs.map((item) => (
            <button key={item.id} type="button" onClick={() => setTab(item.id)}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${tab === item.id ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-white/5'}`}>
              {item.icon}{item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-slate-400">
          <Save className="h-3.5 w-3.5" />{saveNotice}
        </div>
      </div>

      {tab === 'document' && (
        <section className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <div className="flex gap-2">
            <input value={documentTitle} onChange={(event) => setDocumentTitle(event.target.value)}
              aria-label="Document title" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#171e2b] px-3 py-2 text-sm outline-none focus:border-blue-400" />
            <button type="button" onClick={() => downloadText(`${(documentTitle || 'document').replace(/[\\/:*?"<>|]/g, '_')}.txt`, documentBody, 'text/plain;charset=utf-8')}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs hover:bg-blue-500"><Download className="h-4 w-4" /> Export</button>
          </div>
          <textarea value={documentBody} onChange={(event) => setDocumentBody(event.target.value)}
            aria-label="Document contents" placeholder="Write your document here…" className="min-h-0 flex-1 resize-none rounded-lg border border-white/10 bg-[#171e2b] p-4 text-sm leading-6 outline-none focus:border-blue-400" />
          <p className="text-[10px] text-slate-500">Plain-text editor. Saved locally in the browser; export as .txt.</p>
        </section>
      )}

      {tab === 'spreadsheet' && (
        <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-400">Editable 8 × 6 grid · arithmetic and SUM/AVG/MIN/MAX formulas · CSV export</p>
            <button type="button" onClick={() => downloadText('spreadsheet.csv', grid.map((row, rowIndex) =>
              row.map((cell, columnIndex) => `"${displayCell(grid, rowIndex, columnIndex).replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'text/csv;charset=utf-8')}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-2 text-xs hover:bg-emerald-600"><Download className="h-4 w-4" /> Export CSV</button>
          </div>
          <div className="w-full overflow-auto rounded-lg border border-white/10">
            <table className="min-w-full border-collapse text-xs">
              <thead><tr><th className="w-12 bg-[#171e2b] p-2" />
                {Array.from({ length: COLS }, (_, column) => <th key={column} className="min-w-28 border-l border-white/10 bg-[#171e2b] p-2 font-medium">{columnName(column)}</th>)}
              </tr></thead>
              <tbody>{grid.map((row, rowIndex) => (
                <tr key={rowIndex}><th className="border-t border-white/10 bg-[#171e2b] p-2 font-medium">{rowIndex + 1}</th>
                  {row.map((cell, columnIndex) => <td key={columnIndex} className="border-l border-t border-white/10 p-0">
                    <input value={cell} onChange={(event) => updateCell(rowIndex, columnIndex, event.target.value)}
                      aria-label={`${columnName(columnIndex)}${rowIndex + 1}`} className="w-full bg-transparent px-2 py-2 outline-none focus:bg-blue-500/10" />
                    {cell.startsWith('=') && <small className="block px-2 pb-1 text-emerald-300">{displayCell(grid, rowIndex, columnIndex)}</small>}
                  </td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="text-[10px] text-slate-500">Formulas support + − × ÷, cell references, and SUM/AVG/MIN/MAX over cell ranges. This is not full Microsoft Excel.</p>
        </section>
      )}

      {tab === 'slides' && (
        <section className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <div className="flex justify-between">
            <p className="text-xs text-slate-400">Create a simple text-slide deck, saved in this browser.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => downloadText('presentation.json', JSON.stringify(slides, null, 2), 'application/json')}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs hover:bg-white/5"><Download className="h-4 w-4" /> Export</button>
              <button type="button" onClick={() => { setSlides((previous) => [...previous, { title: `Slide ${previous.length + 1}`, body: '' }]); setActiveSlide(slides.length); }}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs hover:bg-blue-500"><Plus className="h-4 w-4" /> Add slide</button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 gap-3">
            <nav className="w-32 shrink-0 space-y-1 overflow-auto">
              {slides.map((slide, index) => <button key={index} type="button" onClick={() => setActiveSlide(index)}
                className={`w-full truncate rounded-lg px-3 py-2 text-left text-xs ${activeSlide === index ? 'bg-blue-600/30 text-blue-100' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>
                {index + 1}. {slide.title || 'Untitled'}
              </button>)}
            </nav>
            {slides[activeSlide] && (
              <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-xl border border-white/10 bg-white p-6 text-slate-900 shadow-xl">
                <input value={slides[activeSlide].title} onChange={(event) => updateSlide('title', event.target.value)}
                  aria-label="Slide title" placeholder="Slide title" className="border-b border-slate-200 pb-2 text-2xl font-semibold outline-none" />
                <textarea value={slides[activeSlide].body} onChange={(event) => updateSlide('body', event.target.value)}
                  aria-label="Slide text" placeholder="Add slide text…" className="min-h-0 flex-1 resize-none text-base leading-7 outline-none" />
                <button type="button" disabled={slides.length <= 1} onClick={() => { setSlides((previous) => previous.filter((_, index) => index !== activeSlide)); setActiveSlide(Math.max(0, activeSlide - 1)); }}
                  className="self-end rounded-md px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40">Delete slide</button>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
};
