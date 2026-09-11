'use client';

/** Small form controls shared by the wizard's steps. */

import React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle2, AlertTriangle, Circle } from 'lucide-react';
import type { Vec3 } from '@/lib/geometry';

export function NumField({ label, value, onChange, step = 'any', min, max, title, disabled, className }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: string; min?: number; max?: number; title?: string; disabled?: boolean; className?: string;
}) {
  return (
    <div title={title} className={className}>
      <Label className="text-[11px]">{label}</Label>
      <Input
        type="number" step={step} min={min} max={max} value={Number.isFinite(value) ? String(value) : ''} disabled={disabled}
        onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        className="font-mono text-xs h-8 mt-0.5"
      />
    </div>
  );
}

/**
 * A value the installation's .cfg already sets: empty means "inherit", and the
 * inherited number is shown as the placeholder so it is never a mystery.
 */
export function InheritField({ label, value, inherited, onChange, title, integer }: {
  label: string; value: number | null; inherited: number; onChange: (v: number | null) => void;
  title?: string; integer?: boolean;
}) {
  return (
    <div title={title}>
      <Label className="text-[11px]">{label}</Label>
      <Input
        type="number" step={integer ? '1' : 'any'} value={value === null ? '' : String(value)}
        placeholder={`${inherited} (installation)`}
        onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className={`font-mono text-xs h-8 mt-0.5 ${value === null ? '' : 'border-primary/60'}`}
      />
    </div>
  );
}

export function Vec3Field({ label, value, onChange, title }: { label: string; value: Vec3; onChange: (v: Vec3) => void; title?: string }) {
  return (
    <div title={title}>
      <Label className="text-[11px]">{label}</Label>
      <div className="grid grid-cols-3 gap-1 mt-0.5">
        {(['x', 'y', 'z'] as const).map((axis, i) => (
          <Input
            key={axis} type="number" step="any" aria-label={`${label} ${axis}`} title={axis}
            value={Number.isFinite(value[i]) ? String(value[i]) : ''}
            onChange={e => { const next = [...value] as Vec3; next[i] = Number(e.target.value); onChange(next); }}
            className="font-mono text-xs h-8"
          />
        ))}
      </div>
    </div>
  );
}

export function Hint({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-[11px] text-muted-foreground ${className}`}>{children}</p>;
}

export function Choice<T extends string>({ value, options, onChange, disabled }: {
  value: T;
  options: { v: T; label: string; desc?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`grid gap-1.5 ${options.length > 2 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'}`}>
      {options.map(o => (
        <button
          key={o.v}
          type="button"
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.v)}
          className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${value === o.v ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
        >
          <div className="font-medium">{o.label}</div>
          {o.desc && <div className="text-[10px] text-muted-foreground">{o.desc}</div>}
        </button>
      ))}
    </div>
  );
}

export interface SubStep { id: string; title: string; problems?: number }

/** The ordered sub-steps of a step, with a mark for those with something to check. */
export function SubStepNav({ steps, current, onSelect }: { steps: SubStep[]; current: number; onSelect: (i: number) => void }) {
  return (
    <nav aria-label="Sub-steps" className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible">
      {steps.map((s, i) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onSelect(i)}
          aria-current={i === current ? 'step' : undefined}
          className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs whitespace-nowrap transition-colors ${i === current ? 'bg-primary/10 text-foreground font-medium' : 'text-muted-foreground hover:bg-accent'}`}
        >
          <span className={`w-5 h-5 flex-shrink-0 rounded-full border flex items-center justify-center font-mono text-[10px] ${i === current ? 'border-primary text-primary' : 'border-muted-foreground/40'}`}>{i + 1}</span>
          <span className="flex-1">{s.title}</span>
          {s.problems ? <AlertTriangle className="w-3 h-3 text-amber-600" /> : i < current ? <CheckCircle2 className="w-3 h-3 text-emerald-600" /> : <Circle className="w-3 h-3 opacity-0" />}
        </button>
      ))}
    </nav>
  );
}
