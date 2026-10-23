import React, { useState, useEffect } from 'react';
import { Save, FilePlus, Check } from 'lucide-react';
import { virtualFs } from '../../services/virtualFs';

interface NotepadProps {
  filePath?: string;
  initialContent?: string;
}

export const NotepadApp: React.FC<NotepadProps> = ({ filePath = 'D:\\New_Document.txt', initialContent = '' }) => {
  const [content, setContent] = useState(initialContent);
  const [path, setPath] = useState(filePath);
  const [isSaved, setIsSaved] = useState(true);
  const [saveSuccessNotice, setSaveSuccessNotice] = useState(false);

  useEffect(() => {
    if (filePath) {
      const node = virtualFs.getNodeByPath(filePath);
      if (node && node.content !== undefined) {
        setContent(node.content);
        setPath(node.path);
        setIsSaved(true);
      }
    }
  }, [filePath]);

  const handleSave = () => {
    const existing = virtualFs.getNodeByPath(path);
    if (existing) {
      virtualFs.updateContent(path, content);
    } else {
      const parts = path.split('\\');
      const filename = parts.pop() || 'Untitled.txt';
      const parent = parts.join('\\') || 'D:';
      virtualFs.createFile(parent, filename, content);
    }
    setIsSaved(true);
    setSaveSuccessNotice(true);
    setTimeout(() => setSaveSuccessNotice(false), 2000);
  };

  const handleNew = () => {
    setContent('');
    setPath('D:\\Untitled.txt');
    setIsSaved(true);
  };

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] text-slate-100 select-none">
      {/* Top Menu Bar */}
      <div className="h-9 border-b border-neutral-800 bg-[#252526] px-3 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleNew}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded hover:bg-white/10 text-slate-300 transition-colors"
          >
            <FilePlus className="w-3.5 h-3.5" />
            <span>New</span>
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 border border-blue-500/30 transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            <span>Save to USB</span>
          </button>
          {saveSuccessNotice && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
              <Check className="w-3 h-3" />
              <span>Saved!</span>
            </span>
          )}
        </div>

        <div className="text-[11px] font-mono text-slate-400 truncate max-w-sm">
          {path} {!isSaved && '*'}
        </div>
      </div>

      {/* Editor Area */}
      <textarea
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setIsSaved(false);
        }}
        placeholder="Type text here..."
        className="flex-1 p-4 bg-[#1e1e1e] text-slate-200 font-mono text-xs focus:outline-none resize-none leading-relaxed select-text placeholder-slate-600"
      />

      {/* Status Bar */}
      <div className="h-6 border-t border-neutral-800 px-4 bg-[#252526] flex items-center justify-between text-[11px] text-slate-400 font-mono">
        <div>
          <span>Lines: {content.split('\n').length}</span>
          <span className="mx-2">·</span>
          <span>Characters: {content.length}</span>
        </div>
        <div>
          <span>UTF-8 · 32GB USB FAT32</span>
        </div>
      </div>
    </div>
  );
};
