'use client';

/**
 * The system/ and constant/ steps: every generated dictionary, editable. An
 * edited file stays as the user left it until "Regenerate" (the wizard records
 * the edit, so "Update case" reproduces it too).
 */

import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { RefreshCw, AlertTriangle, Plus, X } from 'lucide-react';
import { Hint } from './ui';

export interface EditableFile { path: string; content: string; overridden: boolean; note?: string }

export default function FilesStep({ icon, title, description, files, onEdit, extra }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  files: EditableFile[];
  /** null: drop the edit and regenerate. */
  onEdit: (path: string, content: string | null) => void;
  extra?: React.ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const current = files.find(f => f.path === open) ?? files[0];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">{icon} {title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {extra}
        {files.length === 0 ? (
          <p className="text-xs text-muted-foreground">No files here for this case.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1" role="tablist">
              {files.map(f => (
                <button key={f.path} type="button" role="tab" aria-selected={current?.path === f.path} onClick={() => setOpen(f.path)}
                  className={`px-2 py-1 rounded-md border text-xs font-mono ${current?.path === f.path ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}>
                  {f.path.split('/').slice(1).join('/')}
                  {f.overridden && <Badge variant="secondary" className="ml-1 text-[9px]">edited</Badge>}
                  {f.note && <AlertTriangle className="w-3 h-3 inline ml-1 text-amber-600" />}
                </button>
              ))}
            </div>
            {current && (
              <div>
                {current.note && <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1 mb-1"><AlertTriangle className="w-3 h-3 mt-px flex-shrink-0" /> {current.note}</p>}
                <Textarea value={current.content} onChange={e => onEdit(current.path, e.target.value)}
                  className="font-mono text-xs min-h-[360px]" spellCheck={false} aria-label={current.path} />
                {current.overridden && (
                  <Button size="sm" variant="ghost" className="h-6 text-xs mt-1" onClick={() => onEdit(current.path, null)}>
                    <RefreshCw className="w-3 h-3 mr-1" /> Regenerate
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export interface FunctionChoice { line: string; label: string; hint: string }

/** `#includeFunc` lines for system/functions: suggested ones, and any other. */
export function FunctionsPanel({ lines, onChange, suggestions }: {
  lines: string[]; onChange: (l: string[]) => void; suggestions: FunctionChoice[];
}) {
  const [custom, setCustom] = useState('');
  const toggle = (line: string, on: boolean) => onChange(on ? [...lines, line] : lines.filter(l => l !== line));
  const others = lines.filter(l => !suggestions.some(s => s.line === l));
  return (
    <div className="rounded-md border p-2 space-y-2">
      <Label className="text-sm">Function objects (system/functions)</Label>
      <Hint>Run alongside the solver with #includeFunc, from the installation&apos;s caseDicts/functions templates.</Hint>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
        {suggestions.map(s => (
          <label key={s.line} className="flex items-start gap-2 text-xs cursor-pointer" title={s.hint}>
            <Checkbox checked={lines.includes(s.line)} onCheckedChange={v => toggle(s.line, v === true)} className="mt-0.5" />
            <span><span className="font-medium">{s.label}</span> <span className="font-mono text-muted-foreground">{s.line}</span></span>
          </label>
        ))}
      </div>
      {others.map(l => (
        <div key={l} className="flex items-center gap-1 text-xs font-mono">
          {l}<Button size="sm" variant="ghost" className="h-5 w-5 p-0" onClick={() => toggle(l, false)} aria-label={`Remove ${l}`}><X className="w-3 h-3" /></Button>
        </div>
      ))}
      <div className="flex gap-1">
        <Input value={custom} onChange={e => setCustom(e.target.value)} placeholder="another, e.g. probes(points=((0.1 0 0)), fields=(p U))" className="h-7 text-xs font-mono" />
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!custom.trim()}
          onClick={() => { toggle(custom.trim().replace(/^#includeFunc\s+/, ''), true); setCustom(''); }}>
          <Plus className="w-3 h-3 mr-1" /> Add
        </Button>
      </div>
    </div>
  );
}
