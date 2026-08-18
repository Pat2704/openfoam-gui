import { NextResponse } from 'next/server';
import { WslInputError } from './wsl-input';

export function apiError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : 'Internal error';
  const status = error instanceof WslInputError || error instanceof SyntaxError ? 400 : 500;
  return NextResponse.json({ error: message }, { status });
}
