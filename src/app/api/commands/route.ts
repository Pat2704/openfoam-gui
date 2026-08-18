import { NextRequest, NextResponse } from 'next/server';
import { executeCommandAsync } from '@/lib/wsl';
import { apiError } from '@/lib/api-response';
import { validateCaseName, boundedInteger } from '@/lib/wsl-input';

// POST /api/commands
//   { caseName, command, parallel?, nProcs?, background? }
//   → { success, output, message, exitCode }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const caseName = validateCaseName(body?.caseName);
    const command = typeof body?.command === 'string' ? body.command.trim() : '';
    if (!command) {
      return NextResponse.json({ error: 'Command required' }, { status: 400 });
    }
    const _parallel = Boolean(body?.parallel);
    const nProcs = boundedInteger(body?.nProcs, 1, 1, 4096);
    const background = Boolean(body?.background);
    void _parallel; // parallel decomposes the case upstream (mpirun) when enabled
    void nProcs;    // currently forwarded via the command string by the client

    // Background commands are those whose string ends with '&' OR explicitly
    // flagged as background — executeCommandAsync handles the nohup wrapper.
    const fullCommand = background && !command.endsWith('&') ? `${command} &` : command;

    const result = await executeCommandAsync(caseName, fullCommand);
    const success = result.exitCode === 0;
    return NextResponse.json({
      success,
      output: result.output,
      message: success ? 'Command completed' : `Command terminated (exit ${result.exitCode})`,
      exitCode: result.exitCode,
    });
  } catch (error: unknown) {
    return apiError(error);
  }
}
