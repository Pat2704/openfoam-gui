import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-response';
import { callTool, expectedToken } from '@/lib/agent-policy';

/**
 * The endpoint the agent's MCP bridge calls.
 *
 * This is deliberately thin: it authenticates the caller and hands the call to
 * src/lib/agent-policy.ts, which decides what is allowed and writes the log.
 * Nothing here may grow a capability of its own — a policy split across two
 * files is a policy nobody can read.
 *
 * The bridge (electron/mcp/openfoam-mcp.mjs) runs as a child of the Claude Code
 * process the app launched, so it is local by construction; the token stops any
 * OTHER local program from reaching this by guessing the port.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const token = typeof body?.token === 'string' ? body.token : '';
    const expected = expectedToken();
    if (expected && token !== expected) {
      return NextResponse.json({ error: 'bad or missing token' }, { status: 401 });
    }

    const tool = typeof body?.tool === 'string' ? body.tool : '';
    const args = (body?.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>;
    // Comes from the tool server's own environment, which the app set when it
    // launched the agent — never from anything the model wrote.
    const unrestricted = body?.mode === 'unrestricted';

    const result = await callTool(tool, args, unrestricted);
    return NextResponse.json(result);
  } catch (error: unknown) {
    return apiError(error);
  }
}
