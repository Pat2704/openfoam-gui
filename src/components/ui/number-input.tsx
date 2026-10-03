'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { parseNumberInput } from '@/lib/number-input';

type NumberInputProps = Omit<ComponentProps<typeof Input>, 'type' | 'value' | 'onChange' | 'onBlur' | 'onKeyDown' | 'inputMode'> & {
  value: number;
  onValueChange: (value: number) => void;
};

/** Keep empty, minus and exponent drafts until blur/Enter; Escape cancels. */
export function NumberInput({ value, onValueChange, onFocus, min, max, step = 1, ...props }: NumberInputProps) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);

  const commit = () => {
    const next = parseNumberInput(text, {
      min: min === undefined ? undefined : Number(min),
      max: max === undefined ? undefined : Number(max),
      integer: step === 1 || step === '1',
    });
    setText(String(next ?? value));
    if (next !== undefined && next !== value) onValueChange(next);
  };

  return <Input
    {...props}
    type="text"
    inputMode="decimal"
    value={text}
    onFocus={event => {
      focused.current = true;
      event.currentTarget.select();
      onFocus?.(event);
    }}
    onChange={event => setText(event.target.value)}
    onBlur={() => { focused.current = false; commit(); }}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); commit(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setText(String(value)); }
    }}
  />;
}
