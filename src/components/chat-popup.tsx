'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  MessageCircle, X, Send, Trash2, Bot, User, Loader2,
  FolderOpen, GripHorizontal, FileCode, FolderSearch, Check, Zap, Settings,
  RefreshCw, ChevronDown, AlertCircle, Wifi, WifiOff, Plug, CircleDot, Copy
} from 'lucide-react';
import { useCaseContext } from '@/lib/case-context';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/ui/confirm-host';
import { loadFoamyConfig, saveFoamyConfig } from '@/lib/foamy-store';

// ── Provider presets ──
interface ProviderPreset {
  id: string;
  label: string;
  defaultBaseUrl: string;
  defaultApiFormat: string;
  defaultModel: string;
  supportsFetchModels: boolean;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultApiFormat: 'openai-chat',
    defaultModel: 'gpt-4o-mini',
    supportsFetchModels: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultApiFormat: 'anthropic-messages',
    defaultModel: 'claude-sonnet-4-20250514',
    supportsFetchModels: false,
  },
  {
    id: 'groq',
    label: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultApiFormat: 'openai-chat',
    defaultModel: 'llama-3.3-70b-versatile',
    supportsFetchModels: true,
  },
  {
    id: 'custom',
    label: 'Custom',
    defaultBaseUrl: '',
    defaultApiFormat: 'openai-chat',
    defaultModel: '',
    supportsFetchModels: true,
  },
];

const API_FORMATS = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages API' },
];

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string; // ISO string or locale time
  /**
   * The model hit its output cap. Since FOAMy answers with COMPLETE files, a
   * cut reply means a cut file — applying it would truncate the real one, so
   * the apply buttons are withheld.
   */
  truncated?: boolean;
}

interface AppliedFile {
  path: string;
  status: 'idle' | 'applying' | 'ok' | 'error';
}

export default function ChatPopup() {
  const { caseName, activeFile, setActiveFile } = useCaseContext();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(() => `session-${Date.now()}`);
  const [autoContext, setAutoContext] = useState(false);
  const [caseFilesContext, setCaseFilesContext] = useState<string | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [appliedFiles, setAppliedFiles] = useState<Record<string, AppliedFile>>({});
  const [sessionTokens, setSessionTokens] = useState(0);

  // ── LLM configuration — persisted via src/lib/foamy-store.ts ──
  const [llmProvider, setLlmProvider] = useState<string>('');
  const [llmKey, setLlmKey] = useState<string>('');
  const [modelId, setModelId] = useState<string>('');
  const [baseUrl, setBaseUrl] = useState<string>('');
  const [apiFormat, setApiFormat] = useState<string>('');
  const [showSettings, setShowSettings] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [savedConfig, setSavedConfig] = useState(false);
  const [copiedBlock, setCopiedBlock] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── Button: uses direct DOM manipulation for 60fps drag ──
  const btnRef = useRef<HTMLButtonElement>(null);
  const btnPosRef = useRef({ left: 0, top: 0 });
  const btnInitialized = useRef(false);

  // Load the LLM config on mount. In the packaged app this comes from a file
  // in userData (see src/lib/foamy-store.ts for why localStorage cannot be
  // used there); in the browser it comes from localStorage. Async either way.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await loadFoamyConfig();
      if (cancelled) return;
      setLlmProvider(cfg['foamy-llm-provider'] || '');
      setLlmKey(cfg['foamy-llm-key'] || '');
      setModelId(cfg['foamy-model-id'] || '');
      setBaseUrl(cfg['foamy-base-url'] || '');
      setApiFormat(cfg['foamy-api-format'] || '');
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Window positioning ──
  const [winPos, setWinPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [size, setSize] = useState({ w: 420, h: 560 });
  const isDragging = useRef<string | null>(null);
  const isResizing = useRef(false);
  const dragStart = useRef({ mx: 0, my: 0, left: 0, top: 0 });
  const resizeStart = useRef({ mx: 0, my: 0, w: 0, h: 0 });

  // Initialize button position once
  useEffect(() => {
    if (!btnInitialized.current && btnRef.current) {
      const x = window.innerWidth - 86;
      const y = window.innerHeight - 86;
      btnPosRef.current = { left: x, top: y };
      btnRef.current.style.transform = `translate(${x}px, ${y}px)`;
      btnInitialized.current = true;
    }
  }, []);

  const handleOpen = useCallback(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(size.w, vw - 40);
    const h = Math.min(size.h, vh - 40);
    setWinPos({ left: vw - w - 24, top: vh - h - 24 });
    setSize({ w, h });
    setOpen(true);
  }, [size]);

  // ── Global mouse move/up ──
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (isDragging.current === 'button' && btnRef.current) {
        const dx = e.clientX - dragStart.current.mx;
        const dy = e.clientY - dragStart.current.my;
        const newLeft = Math.max(0, Math.min(dragStart.current.left + dx, window.innerWidth - 56));
        const newTop = Math.max(0, Math.min(dragStart.current.top + dy, window.innerHeight - 56));
        btnPosRef.current = { left: newLeft, top: newTop };
        btnRef.current.style.transform = `translate(${newLeft}px, ${newTop}px)`;
        return;
      }
      if (isDragging.current === 'window') {
        const dx = e.clientX - dragStart.current.mx;
        const dy = e.clientY - dragStart.current.my;
        setWinPos({
          left: Math.max(0, Math.min(dragStart.current.left + dx, window.innerWidth - 60)),
          top: Math.max(0, Math.min(dragStart.current.top + dy, window.innerHeight - 60)),
        });
        return;
      }
      if (isResizing.current) {
        const dx = e.clientX - resizeStart.current.mx;
        const dy = e.clientY - resizeStart.current.my;
        setSize(prev => ({
          w: Math.max(300, Math.min(resizeStart.current.w + dx, window.innerWidth - (winPos.left || 0) - 10)),
          h: Math.max(300, Math.min(resizeStart.current.h + dy, window.innerHeight - (winPos.top || 0) - 10)),
        }));
      }
    };
    const onUp = () => {
      isDragging.current = null;
      isResizing.current = false;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [winPos]);

  const onBtnMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStart.current = { mx: e.clientX, my: e.clientY, left: btnPosRef.current.left, top: btnPosRef.current.top };
    isDragging.current = 'button';
    document.body.style.userSelect = 'none';
  }, []);

  const onWinDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStart.current = { mx: e.clientX, my: e.clientY, left: winPos.left, top: winPos.top };
    isDragging.current = 'window';
    document.body.style.userSelect = 'none';
  }, [winPos]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeStart.current = { mx: e.clientX, my: e.clientY, w: size.w, h: size.h };
    isResizing.current = true;
    document.body.style.userSelect = 'none';
  }, [size]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading, appliedFiles]);

  // Focus input when opened
  useEffect(() => {
    if (open && inputRef.current) setTimeout(() => inputRef.current?.focus(), 100);
  }, [open]);

  // Close model dropdown when clicking outside
  useEffect(() => {
    if (!showModelDropdown) return;
    const handler = () => setShowModelDropdown(false);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [showModelDropdown]);

  // ── Fetch full case context ──
  const caseContextSentRef = useRef(false);
  /** Files written since the context was sent, with their current content. */
  const changedFilesRef = useRef<Map<string, string>>(new Map());
  const loadCaseContext = useCallback(async () => {
    if (!caseName) return;
    setLoadingContext(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'readCaseFiles', caseName }),
      });
      const data = await res.json();
      if (data.success) {
        setCaseFilesContext(data.context);
        caseContextSentRef.current = false;
      } else {
        setCaseFilesContext(null);
      }
    } catch { setCaseFilesContext(null); }
    setLoadingContext(false);
  }, [caseName]);

  useEffect(() => {
    if (autoContext && caseName && !caseFilesContext && !loadingContext) loadCaseContext();
    if (!autoContext) {
      setCaseFilesContext(null);
      caseContextSentRef.current = false;
    }
  }, [autoContext, caseName]);

  // ── Fetch models from provider ──
  const handleFetchModels = useCallback(async () => {
    const effectiveBaseUrl = baseUrl.trim() || PROVIDER_PRESETS.find(p => p.id === llmProvider)?.defaultBaseUrl || '';
    if (!effectiveBaseUrl) {
      toast.error('Enter a Base URL before fetching models.');
      return;
    }
    if (!llmKey.trim()) {
      toast.error('Enter an API Key before fetching models.');
      return;
    }
    setFetchingModels(true);
    setFetchedModels([]);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fetchModels', baseUrl: effectiveBaseUrl, apiKey: llmKey }),
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.models)) {
        setFetchedModels(data.models);
        if (data.models.length === 0) {
          toast.info('No models found from provider.');
        } else {
          toast.success(`${data.models.length} models found.`);
        }
      } else {
        toast.error(data.error || 'Error fetching models.');
      }
    } catch {
      toast.error('Connection error while fetching models.');
    } finally {
      setFetchingModels(false);
    }
  }, [baseUrl, llmKey, llmProvider]);

  // ── Provider change handler ──
  const handleProviderChange = useCallback((providerId: string) => {
    const preset = PROVIDER_PRESETS.find(p => p.id === providerId);
    setLlmProvider(providerId);
    setBaseUrl(preset?.defaultBaseUrl || '');
    setApiFormat(preset?.defaultApiFormat || '');
    setFetchedModels([]);
    setShowModelDropdown(false);
    setConnectionStatus('idle');
    setSavedConfig(false);
    // Set default model only if current model is empty or doesn't match the provider
    if (!modelId.trim()) {
      setModelId(preset?.defaultModel || '');
    }
  }, [modelId]);

  // ── Test connection to provider ──
  const handleTestConnection = useCallback(async () => {
    const effectiveBaseUrl = baseUrl.trim() || PROVIDER_PRESETS.find(p => p.id === llmProvider)?.defaultBaseUrl || '';
    const effectiveModel = modelId.trim() || PROVIDER_PRESETS.find(p => p.id === llmProvider)?.defaultModel || '';
    if (!llmProvider || !llmKey.trim() || !effectiveBaseUrl || !effectiveModel) {
      toast.error('Fill in all required fields (Provider, Key, Base URL, Model) before testing.');
      return;
    }
    setTestingConnection(true);
    setConnectionStatus('idle');
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Reply only with: OK',
          sessionId: `test-${Date.now()}`,
          llmProvider,
          llmKey,
          model: effectiveModel,
          baseUrl: effectiveBaseUrl,
          apiFormat: apiFormat.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.reply && !data.error) {
        setConnectionStatus('ok');
        toast.success('Connection successful! Provider responds correctly.');
      } else {
        setConnectionStatus('error');
        toast.error(data.error || data.reply || 'The provider responded with an error.');
      }
    } catch {
      setConnectionStatus('error');
      toast.error('Connection error to server.');
    } finally {
      setTestingConnection(false);
    }
  }, [llmProvider, llmKey, modelId, baseUrl, apiFormat]);

  // ── Persist config (userData file in the packaged app, localStorage in a
  //    browser — see src/lib/foamy-store.ts) ──
  const saveConfig = useCallback(() => {
    void saveFoamyConfig({
      'foamy-llm-provider': llmProvider,
      'foamy-llm-key': llmKey,
      'foamy-model-id': modelId.trim(),
      'foamy-base-url': baseUrl.trim(),
      'foamy-api-format': apiFormat.trim(),
    });
    setSavedConfig(true);
    setConnectionStatus('idle');
    setShowSettings(false);
    setLastError(null);
    toast.success('Configuration saved');
  }, [llmProvider, llmKey, modelId, baseUrl, apiFormat]);

  // ── Apply a file modification ──
  const applyFileChange = useCallback(async (filePath: string, content: string, blockKey: string, skipReadCheck = false) => {
    if (!caseName) return;

    if (!skipReadCheck) {
      try {
        const readRes = await fetch(`/api/cases/${encodeURIComponent(caseName)}?action=read&path=${encodeURIComponent(filePath)}`);
        if (readRes.ok) {
          const readData = await readRes.json();
          const currentLines = (readData.content || '').split('\n').length;
          const newLines = content.trim().split('\n').length;
          if (currentLines > 10 && newLines < currentLines * 0.4) {
            const ok = await confirmDialog(
              `\u26a0\ufe0f Warning: the file "${filePath}" has ${currentLines} lines, but the change proposes only ${newLines}.\n\n` +
              `The file may be incomplete and would be ENTIRELY OVERWRITTEN.\n\n` +
              `Do you want to proceed anyway?`,
              { title: 'Overwrite file?', confirmLabel: 'Overwrite anyway', destructive: true }
            );
            if (!ok) {
              setAppliedFiles(prev => ({ ...prev, [blockKey]: { path: filePath, status: 'idle' } }));
              return;
            }
          }
        }
      } catch { /* if read fails, proceed without warning */ }
    }

    setAppliedFiles(prev => ({ ...prev, [blockKey]: { path: filePath, status: 'applying' } }));
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'write', path: filePath, content }),
      });
      if (res.ok) {
        setAppliedFiles(prev => ({ ...prev, [blockKey]: { path: filePath, status: 'ok' } }));
        // The case context is sent once per session, so without this the model
        // keeps reasoning about the file as it was BEFORE its own change.
        changedFilesRef.current.set(filePath, content);
        if (activeFile && activeFile.path === filePath) {
          setActiveFile({ path: filePath, content });
        }
      } else {
        setAppliedFiles(prev => ({ ...prev, [blockKey]: { path: filePath, status: 'error' } }));
      }
    } catch {
      setAppliedFiles(prev => ({ ...prev, [blockKey]: { path: filePath, status: 'error' } }));
    }
  }, [caseName, activeFile, setActiveFile]);

  // ── Apply ALL file modifications in a message at once ──
  const applyAllChanges = useCallback(async (msgContent: string, msgIndex: number) => {
    const applyRegex = /```apply:([^\n]+)\n([\s\S]*?)```/g;
    const matches: { path: string; content: string; key: string }[] = [];
    let m;
    while ((m = applyRegex.exec(msgContent)) !== null) {
      matches.push({ path: m[1].trim(), content: m[2], key: `msg${msgIndex}-${matches.length}` });
    }
    for (const match of matches) {
      // NOT skipping the read check: "Apply all" used to bypass the
      // shrink guard, so the one-click path was the unprotected one.
      await applyFileChange(match.path, match.content, match.key);
    }
  }, [applyFileChange]);

  // ── Send message ──
  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const fileContext = activeFile ? { path: activeFile.path, content: activeFile.content } : undefined;

    const shouldSendCaseContext = autoContext && !!caseFilesContext && !caseContextSentRef.current;

    setMessages(prev => [...prev, { role: 'user', content: trimmed, timestamp: new Date().toLocaleTimeString() }]);
    setInput('');
    setLoading(true);
    setLastError(null);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          sessionId,
          caseName: caseName || undefined,
          fileContext,
          caseFilesContext: shouldSendCaseContext ? caseFilesContext : undefined,
          forceCaseReload: false,
          changedFiles: changedFilesRef.current.size
            ? Array.from(changedFilesRef.current, ([path, content]) => ({ path, content }))
            : undefined,
          // LLM config from the settings panel (see src/lib/foamy-store.ts).
          llmProvider: llmProvider || undefined,
          llmKey: llmKey || undefined,
          model: modelId.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          apiFormat: apiFormat.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (shouldSendCaseContext) {
        caseContextSentRef.current = true;
      }
      // They are in the conversation history now.
      changedFilesRef.current.clear();

      if (data.error) {
        setLastError(data.error);
        setMessages(prev => [...prev, { role: 'assistant', content: `\u26a0\ufe0f Error: ${data.error}`, timestamp: new Date().toLocaleTimeString() }]);
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.reply || 'No response.',
          timestamp: new Date().toLocaleTimeString(),
          truncated: data.truncated === true,
        }]);
        if (data.tokens?.sessionTotal !== undefined) {
          setSessionTokens(data.tokens.sessionTotal);
        } else if (data.tokens?.total !== undefined) {
          setSessionTokens(prev => prev + data.tokens.total);
        }
      }
    } catch {
      const errorMsg = 'Connection error to server.';
      setLastError(errorMsg);
      setMessages(prev => [...prev, { role: 'assistant', content: `\u26a0\ufe0f ${errorMsg}`, timestamp: new Date().toLocaleTimeString() }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, sessionId, caseName, activeFile, autoContext, caseFilesContext, modelId, llmProvider, llmKey, baseUrl, apiFormat]);

  const clearChat = async () => {
    setMessages([]);
    changedFilesRef.current.clear();
    setCaseFilesContext(null);
    setAppliedFiles({});
    setSessionTokens(0);
    setLastError(null);
    caseContextSentRef.current = false;
    try {
      await fetch('/api/chat', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    } catch { /* silent */ }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── Current effective base URL (for display) ──
  const effectiveBaseUrl = baseUrl.trim() || PROVIDER_PRESETS.find(p => p.id === llmProvider)?.defaultBaseUrl || '';
  const currentPreset = PROVIDER_PRESETS.find(p => p.id === llmProvider);
  const canFetchModels = currentPreset?.supportsFetchModels === true && !!effectiveBaseUrl;

  // ── Render assistant content ──
  const renderContent = (text: string, msgIndex?: number, replyTruncated = false) => {
    const parts = text.split(/(```[\s\S]*?```)/g);

    const applyRegex = /```apply:([^\n]+)\n([\s\S]*?)```/g;
    let hasApplyBlocks = false;
    let applyCount = 0;
    let m;
    while ((m = applyRegex.exec(text)) !== null) { hasApplyBlocks = true; applyCount++; }
    applyRegex.lastIndex = 0;

    const elements: React.ReactNode[] = [];
    let blockIdx = 0;

    for (const part of parts) {
      if (!part) continue;

      if (part.startsWith('```') && part.endsWith('```')) {
        const inner = part.slice(3, -3);
        const firstNewline = inner.indexOf('\n');
        const lang = firstNewline >= 0 ? inner.slice(0, firstNewline).trim() : '';
        const code = firstNewline >= 0 ? inner.slice(firstNewline + 1) : inner;

        if (lang.startsWith('apply:')) {
          const filePath = lang.slice(6).trim();
          const blockKey = `msg${msgIndex ?? 0}-${blockIdx}`;
          const status = appliedFiles[blockKey]?.status || 'idle';

          elements.push(
            <div key={blockIdx} className="my-2 rounded-md overflow-hidden border-2 border-green-300 dark:border-green-700 bg-green-50/50 dark:bg-green-950/20">
              <div className="px-3 py-1.5 bg-green-100 dark:bg-green-900/30 border-b border-green-300 dark:border-green-700 flex items-center justify-between">
                <span className="text-[11px] font-mono font-medium text-green-800 dark:text-green-300">
                  \ud83d\udcdd {filePath}
                </span>
                <div className="flex items-center gap-1.5">
                  {status === 'idle' && (
                    replyTruncated ? (
                      <span className="text-[10px] text-amber-700 dark:text-amber-400 font-medium">
                        Reply cut off — not applicable
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        className="h-6 text-[10px] px-2 bg-green-600 hover:bg-green-700 text-white"
                        onClick={() => applyFileChange(filePath, code, blockKey)}
                      >
                        <Check className="w-3 h-3 mr-0.5" /> Apply change
                      </Button>
                    )
                  )}
                  {status === 'applying' && (
                    <span className="text-[10px] text-green-700 dark:text-green-400 flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" /> Applying...
                    </span>
                  )}
                  {status === 'ok' && (
                    <span className="text-[10px] text-green-700 dark:text-green-400 flex items-center gap-1 font-medium">
                      <Check className="w-3 h-3" /> Applied!
                    </span>
                  )}
                  {status === 'error' && (
                    <span className="text-[10px] text-red-600 flex items-center gap-1 font-medium">
                      Error \u2014 retry
                    </span>
                  )}
                </div>
              </div>
              <pre className="p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-[200px] overflow-y-auto">{code}</pre>
            </div>
          );
          blockIdx++;
          continue;
        }

        {
          const cbKey = 'code-' + String(msgIndex ?? 0) + '-' + blockIdx;
          const isCopied = copiedBlock === cbKey;
          elements.push(
            <div key={blockIdx} className="my-2 rounded-md overflow-hidden border bg-black/5 dark:bg-black/30">
              <div className="px-3 py-1 text-[10px] text-muted-foreground bg-muted/50 border-b font-mono flex items-center justify-between">
                <span>{lang || 'code'}</span>
                <button
                  className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => {
                    navigator.clipboard.writeText(code);
                    setCopiedBlock(cbKey);
                    setTimeout(() => setCopiedBlock(null), 2000);
                  }}
                  title="Copy"
                >
                  {isCopied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
              <pre className="p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap">{code}</pre>
            </div>
          );
        }
        blockIdx++;
        continue;
      }

      // Helper: process inline formatting (links, bold, italic, inline code) within a text segment
      const renderInline = (seg: string): React.ReactNode[] => {
        const out: React.ReactNode[] = [];
        if (!seg) return out;
        // Split by inline code
        const codeSegs = seg.split(/(`[^`]+`)/g);
        for (const cs of codeSegs) {
          if (!cs) continue;
          if (cs.startsWith('`') && cs.endsWith('`')) {
            out.push(<code key={blockIdx++} className="px-1 py-0.5 rounded bg-muted text-xs font-mono">{cs.slice(1, -1)}</code>);
            continue;
          }
          // Split by links [text](url)
          const linkSegs = cs.split(/(\[[^\]]+\]\([^)]+\))/g);
          for (const ls of linkSegs) {
            if (!ls) continue;
            const lm = ls.match(/^\[[^\]]+\]\([^)]+\)$/);
            if (lm) {
              out.push(
                <a key={blockIdx++} href={lm[2]} target="_blank" rel="noopener noreferrer"
                   className="text-primary underline hover:text-primary/80">{lm[1]}</a>
              );
              continue;
            }
            // Split by bold **text**
            const boldSegs = ls.split(/(\*\*[^*]+\*\*)/g);
            for (const bs of boldSegs) {
              if (!bs) continue;
              if (bs.startsWith('**') && bs.endsWith('**')) {
                out.push(<strong key={blockIdx++}>{bs.slice(2, -2)}</strong>);
                continue;
              }
              // Split by italic *text*
              const italicSegs = bs.split(/(\*[^*]+\*)/g);
              for (const is2 of italicSegs) {
                if (!is2) continue;
                if (is2.startsWith('*') && is2.endsWith('*') && is2.length > 2) {
                  out.push(<em key={blockIdx++}>{is2.slice(1, -1)}</em>);
                } else {
                  out.push(<span key={blockIdx++}>{is2}</span>);
                }
              }
            }
          }
        }
        return out;
      };

      // Process text by lines: headings, lists, inline formatting
      const lines = part.split('\n');
      let li = 0;
      while (li < lines.length) {
        const line = lines[li];

        // Headings
        const hMatch = line.match(/^(#{1,3})\s+(.*)/);
        if (hMatch) {
          const lvl = hMatch[1].length;
          const hText = hMatch[2];
          const hCls = lvl === 1 ? 'text-lg font-bold mt-3 mb-1' : lvl === 2 ? 'text-base font-bold mt-3 mb-1' : 'text-sm font-bold mt-3 mb-1';
          elements.push(React.createElement(`h${lvl}`, { key: blockIdx++, className: hCls }, ...renderInline(hText)));
          li++;
          continue;
        }

        // Unordered list
        const ulMatch = line.match(/^[-*]\s+(.*)/);
        if (ulMatch) {
          const items: string[] = [];
          while (li < lines.length && /^[-*]\s+/.test(lines[li])) {
            items.push(lines[li].replace(/^[-*]\s+/, ''));
            li++;
          }
          elements.push(
            <ul key={blockIdx++} className="ml-3 list-disc">
              {items.map((item, i) => <li key={i}>{...renderInline(item)}</li>)}
            </ul>
          );
          continue;
        }

        // Ordered list
        const olMatch = line.match(/^\d+\.\s+(.*)/);
        if (olMatch) {
          const items: string[] = [];
          while (li < lines.length && /^\d+\.\s+/.test(lines[li])) {
            items.push(lines[li].replace(/^\d+\.\s+/, ''));
            li++;
          }
          elements.push(
            <ol key={blockIdx++} className="ml-3 list-decimal">
              {items.map((item, i) => <li key={i}>{...renderInline(item)}</li>)}
            </ol>
          );
          continue;
        }

        // Regular line with inline formatting
        elements.push(...renderInline(line));
        if (li < lines.length - 1) {
          elements.push(<br key={blockIdx++} />);
        }
        li++;
      }
    }

    if (replyTruncated) {
      elements.unshift(
        <div key="truncated" className="mb-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-[11px]">
          <span className="text-amber-600">⚠️</span>
          <span>
            This reply hit the model&apos;s output limit and is <strong>incomplete</strong>. Any file
            below is cut off, so it cannot be applied. Ask for one file at a time, or for a smaller change.
          </span>
        </div>
      );
    }

    if (hasApplyBlocks && applyCount > 1 && msgIndex !== undefined && !replyTruncated) {
      const allApplied = Array.from({ length: applyCount }, (_, i) =>
        appliedFiles[`msg${msgIndex}-${i}`]?.status === 'ok'
      ).every(Boolean);

      if (!allApplied) {
        elements.push(
          <div key="apply-all" className="mt-2 flex justify-end">
            <Button
              size="sm"
              className="h-7 text-[11px] px-3 bg-green-600 hover:bg-green-700 text-white"
              onClick={() => applyAllChanges(text, msgIndex)}
            >
              <Check className="w-3.5 h-3.5 mr-1" /> Apply all changes ({applyCount} files)
            </Button>
          </div>
        );
      }
    }

    return elements;
  };

  return (
    <>
      {/* Floating Button */}
      {!open && (
        <button
          ref={btnRef}
          onMouseDown={onBtnMouseDown}
          onClick={(e) => {
            if (Math.abs(e.clientX - dragStart.current.mx) < 5 && Math.abs(e.clientY - dragStart.current.my) < 5) {
              handleOpen();
            }
          }}
          className="fixed z-[100] w-14 h-14 rounded-full bg-gradient-to-br from-orange-500 to-red-600 text-white shadow-lg hover:shadow-xl hover:shadow-orange-500/25 flex items-center justify-center group cursor-grab active:cursor-grabbing transition-shadow duration-150"
          style={{ left: 0, top: 0, transform: `translate(${btnPosRef.current.left}px, ${btnPosRef.current.top}px)`, willChange: 'transform' }}
          title="FOAMy - OpenFOAM Assistant (draggable)"
        >
          <MessageCircle className="w-6 h-6" />
          <span className="absolute -top-1 -right-1 w-4 h-4 bg-green-400 rounded-full border-2 border-background" />
        </button>
      )}

      {/* Chat Window */}
      {open && (
        <div
          className="fixed z-[100] flex flex-col rounded-xl border shadow-2xl bg-card overflow-hidden"
          style={{ left: winPos.left, top: winPos.top, width: size.w, height: size.h }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-3 py-2.5 border-b bg-gradient-to-r from-orange-500/10 to-red-600/10 cursor-grab active:cursor-grabbing select-none"
            onMouseDown={onWinDragStart}
          >
            <div className="flex items-center gap-2 min-w-0">
              <GripHorizontal className="w-4 h-4 text-muted-foreground/40 flex-shrink-0" />
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center flex-shrink-0">
                <Bot className="w-3.5 h-3.5 text-white" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold leading-tight">FOAMy</div>
                <div className="text-[9px] text-muted-foreground flex items-center gap-1.5 leading-tight">
                  {caseName ? (
                    <span className="truncate max-w-[100px]">{caseName}</span>
                  ) : (
                    <span>OpenFOAM Assistant</span>
                  )}
                  {modelId && (
                    <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded bg-blue-100 dark:bg-blue-950/40 text-[8px] font-mono text-blue-700 dark:text-blue-300 flex-shrink-0 truncate max-w-[80px]" title={`${llmProvider.toUpperCase()} / ${modelId}`}>
                      <CircleDot className={`w-2 h-2 flex-shrink-0 ${savedConfig ? 'text-green-500' : 'text-amber-400'}`} />
                      {modelId}
                    </span>
                  )}
                  {sessionTokens > 0 && (
                    <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded bg-muted text-[8px] font-mono flex-shrink-0" title="Tokens used in this session">
                      <Zap className="w-2 h-2 text-amber-500" />{sessionTokens.toLocaleString('en-US')}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0" onMouseDown={e => e.stopPropagation()}>
              <button
                className={`p-1.5 rounded-md transition-colors ${showSettings ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent'}`}
                onClick={() => setShowSettings(s => !s)} title="LLM Settings"
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
              <button
                className="p-1.5 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                onClick={clearChat} title="Clear chat"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button
                className="p-1.5 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                onClick={() => setOpen(false)} title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Settings panel — full LLM config (provider + key + model + baseUrl + apiFormat) */}
          {showSettings && (
            <div className="border-b bg-gradient-to-b from-muted/40 to-muted/20" onMouseDown={e => e.stopPropagation()}>
              <div className="px-3 py-2 border-b border-border/50 bg-gradient-to-r from-orange-500/5 to-red-600/5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Plug className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-[11px] font-semibold text-foreground">LLM Configuration</span>
                  </div>
                  <div className={
                    'flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full ' +
                    (connectionStatus === 'ok'
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                      : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400')
                  }>
                    {connectionStatus === 'ok' && <><Wifi className="w-2.5 h-2.5" /> Connected</>}
                    {connectionStatus === 'error' && <><WifiOff className="w-2.5 h-2.5" /> Error</>}
                  </div>
                </div>
              </div>

              <div className="px-3 py-3 space-y-3 max-h-[55vh] overflow-y-auto">
                {/* Provider selection */}
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">Provider</label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {PROVIDER_PRESETS.map(p => (
                      <button
                        key={p.id}
                        onClick={() => handleProviderChange(p.id)}
                        className={`text-[11px] px-2 py-1.5 rounded-lg border transition-all font-medium text-center ${
                          llmProvider === p.id
                            ? 'bg-primary text-primary-foreground border-primary shadow-sm shadow-primary/25'
                            : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground hover:border-border'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* API Key */}
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">API Key</label>
                  <div className="flex gap-1.5">
                    <div className="relative flex-1">
                      <input
                        type="password"
                        value={llmKey}
                        onChange={e => { setLlmKey(e.target.value); setSavedConfig(false); }}
                        placeholder="sk-... / gsk_... / sk-ant-..."
                        className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg border border-border bg-background pr-7 focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50"
                      />
                      {llmKey && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-green-500" title="Key set" />
                      )}
                    </div>
                    {llmKey && (
                      <button
                        className="px-2 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-red-500 hover:border-red-300 hover:bg-red-50 dark:hover:bg-red-950/20 text-[11px] transition-all"
                        onClick={() => {
                          setLlmKey('');
                          // Persist the removal through the same store the rest
                          // of the config uses, so it also clears the encrypted
                          // key in userData when running the packaged app.
                          void saveFoamyConfig({
                            'foamy-llm-provider': llmProvider,
                            'foamy-llm-key': '',
                            'foamy-model-id': modelId.trim(),
                            'foamy-base-url': baseUrl.trim(),
                            'foamy-api-format': apiFormat.trim(),
                          });
                          toast.info('API key removed');
                          setSavedConfig(false);
                        }}
                        title="Remove API key"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Base URL */}
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">Base URL</label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={e => { setBaseUrl(e.target.value); setSavedConfig(false); }}
                    placeholder={currentPreset?.defaultBaseUrl || 'https://api.example.com/v1'}
                    className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50"
                  />
                  {llmProvider && !baseUrl.trim() && currentPreset?.defaultBaseUrl && (
                    <p className="text-[9px] text-muted-foreground/50 mt-1 pl-0.5">
                      <span className="font-medium">Default:</span> <code className="font-mono">{currentPreset.defaultBaseUrl}</code>
                    </p>
                  )}
                </div>

                {/* API Format */}
                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">API Format</label>
                  <select
                    value={apiFormat}
                    onChange={e => { setApiFormat(e.target.value); setSavedConfig(false); }}
                    className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50"
                  >
                    <option value="">Auto (from selected provider)</option>
                    {API_FORMATS.map(f => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                  </select>
                  {llmProvider && !apiFormat && currentPreset?.defaultApiFormat && (
                    <p className="text-[9px] text-muted-foreground/50 mt-1 pl-0.5">
                      <span className="font-medium">Default:</span> {API_FORMATS.find(f => f.value === currentPreset.defaultApiFormat)?.label}
                    </p>
                  )}
                </div>

                {/* Model ID */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Model ID</label>
                    {canFetchModels && (
                      <button
                        onClick={e => { e.stopPropagation(); handleFetchModels(); }}
                        disabled={fetchingModels}
                        className="text-[10px] text-primary hover:text-primary/80 flex items-center gap-1 font-medium disabled:opacity-50 transition-colors"
                      >
                        <RefreshCw className={`w-3 h-3 ${fetchingModels ? 'animate-spin' : ''}`} />
                        {fetchingModels ? 'Fetching...' : 'Fetch available models'}
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type="text"
                      value={modelId}
                      onChange={e => { setModelId(e.target.value); setShowModelDropdown(true); setSavedConfig(false); }}
                      onFocus={() => { if (fetchedModels.length > 0) setShowModelDropdown(true); }}
                      placeholder={currentPreset?.defaultModel || 'e.g. gpt-4o, claude-sonnet-4-20250514, llama-3.3-70b-versatile'}
                      className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg border border-border bg-background pr-7 focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50"
                    />
                    {fetchedModels.length > 0 && (
                      <button
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                        onClick={e => { e.stopPropagation(); setShowModelDropdown(d => !d); }}
                      >
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {/* Model dropdown */}
                    {showModelDropdown && fetchedModels.length > 0 && (
                      <div
                        className="absolute z-50 top-full left-0 right-0 mt-1 max-h-44 overflow-y-auto border border-border rounded-lg bg-popover shadow-xl"
                        onClick={e => e.stopPropagation()}
                      >
                        {/* Opaque background (no backdrop-blur on a sticky
                            element) — see electron/main.js for why. */}
                        <div className="sticky top-0 bg-popover px-2 py-1 border-b border-border/50">
                          <span className="text-[9px] text-muted-foreground font-medium">{fetchedModels.filter(m => !modelId || m.toLowerCase().includes(modelId.toLowerCase())).length} models</span>
                        </div>
                        {fetchedModels
                          .filter(m => !modelId || m.toLowerCase().includes(modelId.toLowerCase()))
                          .slice(0, 50)
                          .map(m => (
                            <button
                              key={m}
                              className={`block w-full text-left text-[11px] font-mono px-2.5 py-1.5 transition-colors truncate hover:bg-accent ${modelId === m ? 'bg-accent text-accent-foreground' : 'text-foreground'}`}
                              onClick={() => {
                                setModelId(m);
                                setShowModelDropdown(false);
                                setSavedConfig(false);
                              }}
                            >
                              {m}
                            </button>
                          ))}
                        {fetchedModels.filter(m => !modelId || m.toLowerCase().includes(modelId.toLowerCase())).length === 0 && (
                          <div className="px-2.5 py-2 text-[10px] text-muted-foreground italic text-center">No matching models</div>
                        )}
                      </div>
                    )}
                  </div>
                  {fetchedModels.length > 0 && (
                    <p className="text-[9px] text-muted-foreground/50 mt-1 pl-0.5">
                      {fetchedModels.length} models available — type to filter
                    </p>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="default" className="h-8 text-[11px] px-3 flex-1"
                    onClick={saveConfig}
                  >
                    <Check className="w-3.5 h-3.5 mr-1" /> Save
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 text-[11px] px-3"
                    onClick={handleTestConnection}
                    disabled={testingConnection}
                  >
                    <Wifi className={`w-3.5 h-3.5 mr-1 ${testingConnection ? 'animate-pulse' : ''}`} />
                    {testingConnection ? 'Testing...' : 'Test'}
                  </Button>
                </div>

                {!llmProvider && (
                  <div className="flex items-start gap-1.5 p-2 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/30">
                    <AlertCircle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                    <p className="text-[10px] text-amber-700 dark:text-amber-400 leading-relaxed">Select a provider, enter the API key and model to start using FOAMy.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Last error banner */}
          {lastError && !showSettings && (
            <div className="px-3 py-1.5 bg-red-50 dark:bg-red-950/20 border-b border-red-200 dark:border-red-800/30">
              <p className="text-[10px] text-red-600 dark:text-red-400 flex items-center gap-1">
                <AlertCircle className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{lastError}</span>
              </p>
            </div>
          )}

          {/* Context bar */}
          <div className="px-3 py-2 border-b bg-muted/30 flex items-center gap-2 flex-wrap">
            {activeFile ? (
              <Badge variant="secondary" className="text-[11px] gap-1 py-0.5 px-2">
                <FileCode className="w-3.5 h-3.5 text-blue-500" />
                <span className="font-mono max-w-[140px] truncate">{activeFile.path}</span>
                <span className="text-green-500 text-[9px] font-medium">AUTO</span>
              </Badge>
            ) : (
              <span className="text-[11px] text-muted-foreground italic">No file open in editor</span>
            )}
            <button
              onClick={() => {
                if (!caseName) return;
                const next = !autoContext;
                setAutoContext(next);
                if (next && !caseFilesContext) loadCaseContext();
                if (!next) setCaseFilesContext(null);
              }}
              disabled={!caseName || loadingContext}
              className={`text-[11px] px-2 py-0.5 rounded-md border flex items-center gap-1.5 transition-colors font-medium ${
                !caseName
                  ? 'border-muted-foreground/20 text-muted-foreground/40 cursor-not-allowed'
                  : autoContext
                    ? 'bg-orange-100 dark:bg-orange-950/40 border-orange-400 dark:border-orange-600 text-orange-700 dark:text-orange-300'
                    : 'border-orange-300 dark:border-orange-700 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/20'
              }`}
              title={autoContext ? 'FOAMy sees all case files' : 'Click to let FOAMy read all case files'}
            >
              <FolderSearch className="w-3.5 h-3.5" />
              {loadingContext ? 'Reading...' : autoContext ? 'Case context ON' : 'Case context'}
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <Bot className="w-12 h-12 mb-3 opacity-20" />
                <p className="text-sm text-center">Hi! I&apos;m <strong>FOAMy</strong></p>
                <p className="text-xs mt-1 text-center px-4">Ask me anything about OpenFOAM, CFD, case configuration, mesh, boundary conditions...</p>
                {caseName && (
                  <Badge variant="secondary" className="mt-2 text-[10px] gap-1">
                    <FolderOpen className="w-3 h-3" /> {caseName}
                  </Badge>
                )}
                {activeFile && (
                  <div className="mt-2 text-[10px] text-center text-muted-foreground">
                    <FileCode className="w-3 h-3 inline mr-1 text-blue-400" />
                    I see the file <span className="font-mono font-medium">{activeFile.path}</span> open in editor
                  </div>
                )}
                <div className="mt-4 space-y-1.5 text-xs w-full">
                  {[
                    'How do I configure boundary conditions?',
                    'What numerical schemes do you recommend for RANS?',
                    'How do I run foamRun with parallelism?',
                    'How do I interpret residuals in the log?',
                  ].map((q, i) => (
                    <button key={i} onClick={() => { setInput(q); }}
                      className="block w-full text-left px-3 py-1.5 rounded-lg border hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Bot className="w-3 h-3 text-white" />
                  </div>
                )}
                <div className={`max-w-[85%] ${msg.role === 'user' ? 'flex flex-col items-end' : ''}`}>
                  <div className={`rounded-lg px-3 py-2 text-sm ${
                    msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                  }`}>
                    {renderContent(msg.content, i, msg.truncated === true)}
                  </div>
                  {msg.timestamp && (
                    <span className="text-[9px] text-muted-foreground/60 mt-0.5 px-1">{msg.timestamp}</span>
                  )}
                </div>
                {msg.role === 'user' && (
                  <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <User className="w-3 h-3" />
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="flex gap-2 justify-start">
                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-3 h-3 text-white" />
                </div>
                <div className="bg-muted rounded-lg px-3 py-2">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t p-3">
            <div className="flex gap-1.5 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={activeFile ? `Ask FOAMy... (${activeFile.path})` : 'Ask FOAMy...'}
                className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm min-h-[38px] max-h-[100px] focus:outline-none focus:ring-1 focus:ring-primary"
                rows={1}
                disabled={loading}
              />
              <Button
                size="sm"
                onClick={sendMessage}
                disabled={!input.trim() || loading}
                className="h-[38px] w-[38px] p-0 rounded-lg bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 flex-shrink-0"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </div>
            {(activeFile || (autoContext && caseFilesContext)) && (
              <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                {activeFile && (
                  <span className="text-[9px] text-muted-foreground">
                    \ud83d\udcc4 <span className="font-mono">{activeFile.path}</span> (auto)
                  </span>
                )}
                {autoContext && caseFilesContext && (
                  <span className="text-[9px] text-orange-500">\ud83d\udcc1 Full case context active</span>
                )}
              </div>
            )}
          </div>

          {/* Resize handle */}
          <div
            className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize flex items-end justify-end p-0.5"
            onMouseDown={onResizeStart}
            title="Drag to resize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" className="text-muted-foreground/40">
              <path d="M9 1v8H1M9 5v4H5M9 8h-1" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            </svg>
          </div>
        </div>
      )}
    </>
  );
}
