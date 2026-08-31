import path from 'path';

export class WslInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WslInputError';
  }
}

export function validateCaseName(value: string): string {
  if (typeof value !== 'string' || !value) {
    throw new WslInputError('Case name required');
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u.test(value) || value === '.' || value === '..') {
    throw new WslInputError('Invalid case name: use letters, numbers, dot, dash or underscore');
  }
  return value;
}

export function validateRelativePath(value: string, label = 'Path', allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value)) {
    throw new WslInputError(`${label} required`);
  }
  if (value.length > 1024 || value.includes('\\') || /[\0\r\n]/.test(value) || path.posix.isAbsolute(value)) {
    throw new WslInputError(`${label} invalid`);
  }

  if (allowEmpty && value === '') return '';
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new WslInputError(`${label} must remain within the case`);
  }
  return segments.join('/');
}

export function validatePathWithin(basePath: string, candidatePath: string, label: string): string {
  if (typeof candidatePath !== 'string' || !candidatePath || /[\0\r\n]/.test(candidatePath)) {
    throw new WslInputError(`${label} invalid`);
  }

  const normalizedBase = path.posix.normalize(basePath).replace(/\/$/, '');
  const normalizedCandidate = path.posix.normalize(candidatePath);
  if (!path.posix.isAbsolute(normalizedBase) || !path.posix.isAbsolute(normalizedCandidate)) {
    throw new WslInputError(`${label} invalid`);
  }
  if (normalizedCandidate === normalizedBase || !normalizedCandidate.startsWith(`${normalizedBase}/`)) {
    throw new WslInputError(`${label} outside the tutorial directory`);
  }
  return normalizedCandidate;
}

export function validateLogName(value: string): string {
  if (value === 'log') return value;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u.test(value)) {
    throw new WslInputError('Invalid log name');
  }
  return value;
}

export function validatePid(value: string): string {
  if (!/^[1-9]\d{0,9}$/.test(value)) {
    throw new WslInputError('Invalid PID');
  }
  return value;
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
