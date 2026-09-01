'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Toaster, toast } from 'sonner';
import { useTheme } from 'next-themes';
import {
  LayoutDashboard, Wand2, FileCode, Terminal, Activity,
  TerminalSquare, Waves, Cpu, X, Boxes, FolderTree,
  Keyboard, Sun, Moon, Zap, Box
} from 'lucide-react';
import Dashboard from '@/components/openfoam/dashboard';
import CaseWizard from '@/components/openfoam/case-wizard';
import FileEditor from '@/components/openfoam/file-editor';
import CommandPanel from '@/components/openfoam/command-panel';
import Monitor from '@/components/openfoam/monitor';
import MeshViewer from '@/components/openfoam/mesh-viewer';
import OpenFoamBrowser from '@/components/openfoam/foam-browser';
import { useCaseContext } from '@/lib/case-context';

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: 'wizard', label: 'New Case', icon: <Wand2 className="w-4 h-4" /> },
  { id: 'editor', label: 'File Editor', icon: <FileCode className="w-4 h-4" /> },
  { id: 'commands', label: 'Commands', icon: <Terminal className="w-4 h-4" /> },
  { id: 'monitor', label: 'Monitor', icon: <Activity className="w-4 h-4" /> },
  { id: 'mesh', label: 'Mesh', icon: <Box className="w-4 h-4" /> },
  { id: 'applications', label: 'Applications', icon: <Boxes className="w-4 h-4" /> },
  { id: 'src', label: 'Src', icon: <FolderTree className="w-4 h-4" /> },
];

const SHORTCUTS = [
  { keys: 'Ctrl + S', desc: 'Save the open file in the editor' },
  { keys: 'Ctrl + Enter', desc: 'Send message in chat' },
  { keys: 'Ctrl + /', desc: 'Show/hide keyboard shortcuts' },
  { keys: 'Ctrl + 1-7', desc: 'Switch tab (Dashboard, Wizard, Editor, ...)' },
  { keys: '↑ / ↓', desc: 'Navigate command history in the terminal' },
  { keys: 'Ctrl + F', desc: 'Search in the file open in the editor' },
  { keys: 'Ctrl + B', desc: 'Switch light/dark theme' },
];

export default function Home() {
  const { setCaseName, setActiveFile } = useCaseContext();
  // resolvedTheme, not theme: the provider runs with enableSystem, so `theme`
  // can be the literal 'system' — comparing it to 'dark' mislabels the button
  // and makes the toggle a no-op when the OS is already dark.
  const { resolvedTheme, setTheme } = useTheme();
  // next-themes cannot know the theme until it has read localStorage on the
  // client, so `resolvedTheme` is undefined during SSR and on the first client
  // render. Rendering the icon/label straight from it made the server emit the
  // light-mode button and the client the dark-mode one — a hydration mismatch.
  // Gate the theme-dependent output on `mounted` so the first client render
  // matches the server exactly, then swap on the next tick.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const isDark = mounted && resolvedTheme === 'dark';
  const [activeTab, setActiveTab] = useState('dashboard');
  /** Bumped whenever the case list changes from outside the Dashboard. */
  const [caseListVersion, setCaseListVersion] = useState(0);
  // Tabs are mounted lazily on first visit and then kept mounted, hidden
  // with CSS. Previously each tab was conditionally rendered, so every
  // switch unmounted the component and re-ran all of its WSL fetches —
  // which is what made changing section feel slow. Mounting lazily (rather
  // than all seven up front) keeps startup cheap.
  const [visitedTabs, setVisitedTabs] = useState<string[]>(['dashboard']);
  useEffect(() => {
    setVisitedTabs(prev => (prev.includes(activeTab) ? prev : [...prev, activeTab]));
  }, [activeTab]);
  // Tailwind's `hidden` (display:none) rather than unmounting.
  const paneClass = (id: string) => (activeTab === id ? undefined : 'hidden');
  // Open cases: array of names. First element is the active one.
  const [openCases, setOpenCases] = useState<string[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [wslConnected, setWslConnected] = useState<boolean | null>(null);
  const [wslDistro, setWslDistro] = useState<string>('');
  const wslCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedCase = openCases[0] || null;

  // Sync selectedCase to global context (so ChatPopup can read it)
  useEffect(() => {
    setCaseName(selectedCase);
    setActiveFile(null); // reset active file when case changes
  }, [selectedCase, setCaseName, setActiveFile]);

  const handleSelectCase = (name: string) => {
    // If already open, just bring to front (make active)
    if (openCases.includes(name)) {
      setOpenCases(prev => [name, ...prev.filter(c => c !== name)]);
    } else {
      setOpenCases(prev => [name, ...prev]);
    }
    setActiveTab('editor');
  };

  const handleCloseCase = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenCases(prev => prev.filter(c => c !== name));
  };

  const handleCaseCreated = () => {
    // The Dashboard caches its case list, so tell it to refetch: otherwise the
    // freshly created case is missing from the list it lands on.
    setCaseListVersion(v => v + 1);
    setActiveTab('dashboard');
  };

  // A case script (Allrun) was launched in the background: move to the
  // Monitor so the user can follow it. Deliberately WITHOUT preselecting a
  // log — log.Allrun does not exist yet at this instant (it is created when
  // the script writes its first line), and the per-application logs appear
  // only as the run reaches them. Picking the log is left to the user.
  const handleScriptStarted = () => {
    setActiveTab('monitor');
  };

  // WSL connection health check — lightweight ping every 10s
  const checkWsl = useCallback(async () => {
    try {
      const r = await fetch('/api/wsl?action=ping');
      const d = await r.json();
      setWslConnected(d.running === true);
      setWslDistro(typeof d.name === 'string' ? d.name : '');
    } catch {
      setWslConnected(false);
      setWslDistro('');
    }
  }, []);

  useEffect(() => {
    checkWsl();
    wslCheckRef.current = setInterval(checkWsl, 10000);
    return () => { if (wslCheckRef.current) clearInterval(wslCheckRef.current); };
  }, [checkWsl]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+B → toggle dark/light mode
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        setTheme(isDark ? 'light' : 'dark');
        return;
      }
      // Ctrl+/  →  toggle shortcuts dialog
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setShowShortcuts(d => !d);
        return;
      }
      // Ctrl+1..7  →  switch tabs
      if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '7') {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (TABS[idx]) setActiveTab(TABS[idx].id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header — NOTE: keep this background fully opaque (bg-card, not
          bg-card/80 + backdrop-blur-sm). Under Electron we run with GPU
          acceleration disabled, and a blurred backdrop on a sticky element
          forces a full-page repaint in software compositing on every
          keystroke — which is what made text inputs appear to freeze.
          See the long comment at the top of electron/main.js. */}
      <header className="border-b bg-card sticky top-0 z-50">
        <div className="max-w-[1800px] mx-auto px-3 sm:px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center">
                <Waves className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-base font-bold leading-tight">OpenFOAM Studio</h1>
                <p className="text-[10px] text-muted-foreground leading-tight">Web GUI for CFD simulations</p>
              </div>
            </div>
            <Badge
              variant="outline"
              className="hidden sm:flex text-[10px] gap-1.5 cursor-help"
              title={wslConnected === null
                ? 'Checking WSL2 status…'
                : wslConnected
                  ? `Connected${wslDistro ? ' · ' + wslDistro : ''}`
                  : 'WSL2 unreachable'}
            >
              <TerminalSquare className="w-3 h-3" />
              <span>WSL2</span>
              {wslDistro && wslConnected && (
                <span className="font-mono text-[9px] text-muted-foreground max-w-[80px] truncate">
                  {wslDistro}
                </span>
              )}
              <span
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  wslConnected === null
                    ? 'bg-muted-foreground/40'
                    : wslConnected
                      ? 'bg-green-500 animate-pulse'
                      : 'bg-red-500'
                }`}
              />
            </Badge>
            <button
              onClick={() => setTheme(isDark ? 'light' : 'dark')}
              className="p-1.5 rounded-lg border border-border hover:bg-accent transition-colors sm:px-2 sm:gap-1.5"
              title="Switch theme (Ctrl+B)"
            >
              {isDark ? <Sun className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <Moon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
              <span className="hidden sm:inline text-xs">{isDark ? 'Light' : 'Dark'}</span>
            </button>
          </div>
          {/* Open cases tabs */}
          <div className="flex items-center gap-1.5 max-w-[50%] overflow-x-auto">
            {openCases.map(name => (
              <button
                key={name}
                onClick={() => {
                  // Bring this case to front as active
                  setOpenCases(prev => [name, ...prev.filter(c => c !== name)]);
                }}
                className={`flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs px-1.5 sm:px-2.5 py-1 rounded-full border transition-colors flex-shrink-0 ${
                  name === selectedCase
                    ? 'bg-primary/10 border-primary text-primary font-medium'
                    : 'bg-muted/50 border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                <Cpu className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                <span className="font-mono max-w-[80px] sm:max-w-[120px] truncate">{name}</span>
                <span
                  className="ml-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
                  onClick={(e) => handleCloseCase(name, e)}
                >
                  <X className="w-3 h-3" />
                </span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Tabs Navigation */}
      <div className="border-b bg-card/40">
        <div className="max-w-[1800px] mx-auto px-3 sm:px-4">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="bg-transparent h-auto p-0 gap-0">
              {TABS.map((tab) => (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  className="relative rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-3 py-2.5 text-sm gap-1.5 transition-colors"
                >
                  {tab.icon}
                  <span className="hidden sm:inline">{tab.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 max-w-[1800px] mx-auto w-full px-3 sm:px-4 py-4">
        {visitedTabs.includes('dashboard') && (
          <div className={paneClass('dashboard')}>
            <Dashboard
              selectedCase={selectedCase}
              onSelectCase={handleSelectCase}
              onRefresh={() => {}}
              refreshSignal={caseListVersion}
            />
          </div>
        )}
        {visitedTabs.includes('wizard') && (
          <div className={paneClass('wizard')}>
            <CaseWizard onCreated={handleCaseCreated} />
          </div>
        )}
        {visitedTabs.includes('editor') && (
          <div className={paneClass('editor')}>
            {selectedCase ? (
              <FileEditor key={selectedCase} caseName={selectedCase} />
            ) : (
              <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
                <div className="text-center">
                  <FileCode className="w-12 h-12 mx-auto mb-2 opacity-30" />
                  <p>Select a case from the Dashboard to edit its files</p>
                  <p className="text-xs mt-1">Or create a new case with the Wizard</p>
                </div>
              </div>
            )}
          </div>
        )}
        {visitedTabs.includes('commands') && (
          <div className={paneClass('commands')}>
            <CommandPanel key={selectedCase || 'none'} caseName={selectedCase || ''} onScriptStarted={handleScriptStarted} />
          </div>
        )}
        {visitedTabs.includes('monitor') && (
          <div className={paneClass('monitor')}>
            <Monitor key={selectedCase || 'none'} caseName={selectedCase || ''} active={activeTab === 'monitor'} />
          </div>
        )}
        {visitedTabs.includes('mesh') && (
          <div className={paneClass('mesh')}>
            <MeshViewer key={selectedCase || 'none'} caseName={selectedCase || ''} active={activeTab === 'mesh'} />
          </div>
        )}
        {visitedTabs.includes('applications') && (
          <div className={paneClass('applications')}>
            <OpenFoamBrowser section="applications" />
          </div>
        )}
        {visitedTabs.includes('src') && (
          <div className={paneClass('src')}>
            <OpenFoamBrowser section="src" />
          </div>
        )}
      </main>

      {/* Footer — opaque background for the same reason as the header. */}
      <footer className="border-t bg-card py-2 mt-auto">
        <div className="max-w-[1800px] mx-auto px-3 sm:px-4 flex items-center justify-between text-[10px] text-muted-foreground gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Zap className="w-3 h-3 text-primary/70 flex-shrink-0" />
            <span className="truncate font-medium">OpenFOAM Studio</span>
            <span className="hidden md:inline text-border">·</span>
            <span className="hidden md:inline truncate">
              {wslConnected === null
                ? 'Checking WSL2…'
                : wslConnected
                  ? `WSL2${wslDistro ? ' · ' + wslDistro : ''} · online`
                  : 'WSL2 offline'}
            </span>
            {selectedCase && (
              <>
                <span className="hidden lg:inline text-border">·</span>
                <span className="hidden lg:inline font-mono truncate text-primary/80">
                  {selectedCase}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="hidden sm:inline">CFD via WSL2</span>
            <button
              onClick={() => setShowShortcuts(true)}
              className="flex items-center gap-1 hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-accent"
              title="Keyboard shortcuts (Ctrl+/)"
            >
              <Keyboard className="w-3 h-3" />
              <span className="hidden sm:inline">Ctrl+/</span>
            </button>
          </div>
        </div>
      </footer>

      {/* Keyboard Shortcuts Dialog */}
      <Dialog open={showShortcuts} onOpenChange={setShowShortcuts}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Keyboard className="w-5 h-5" />
              Keyboard shortcuts
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 pt-2">
            {SHORTCUTS.map((s, i) => (
              <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-muted/50 transition-colors">
                <span className="text-sm text-muted-foreground">{s.desc}</span>
                <kbd className="text-xs font-mono bg-muted px-2 py-0.5 rounded border border-border shadow-sm">
                  {s.keys}
                </kbd>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
