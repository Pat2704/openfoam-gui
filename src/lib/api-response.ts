import { NextResponse } from 'next/server';
import { WslInputError } from './wsl-input';
import { FunctionSpecError } from './postprocess';

export function apiError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : 'Internal error';
  // A rejected function-object specification is the caller's mistake in exactly
  // the way a rejected case name is, and reporting it as a server fault would
  // send the user looking for a broken installation instead of a bad field.
  const badRequest = error instanceof WslInputError
    || error instanceof FunctionSpecError
    || error instanceof SyntaxError;
  return NextResponse.json({ error: message }, { status: badRequest ? 400 : 500 });
}
