/** A complete number, never an unfinished edit coerced to zero. */
export function parseNumberInput(text: string, limits: { min?: number; max?: number; integer?: boolean } = {}): number | undefined {
  const token = text.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) return undefined;
  const value = Number(token);
  if (!Number.isFinite(value) || (limits.integer && !Number.isInteger(value))) return undefined;
  if (limits.min !== undefined && value < limits.min) return undefined;
  if (limits.max !== undefined && value > limits.max) return undefined;
  return value;
}
