/**
 * The shared secret between the app and the agent's tool bridge.
 *
 * electron/main.js generates one per launch and puts it in the server's
 * environment; the same value is handed to the bridge in its own environment
 * (see mcpConfig in src/lib/claude-cli.ts). The server only listens on
 * 127.0.0.1, so this is not defending against the network — it stops another
 * local program from driving the user's cases just because it guessed the port.
 *
 * WHY THIS IS ITS OWN MODULE, AND WHY IT NEVER RETURNS EMPTY
 * ---------------------------------------------------------
 * The token used to be read straight from the environment, and /api/agent/tools
 * treated an empty one as "no check configured" rather than "no token". Outside
 * Electron nothing sets the variable — neither `npm run dev` nor `npm start` —
 * so in exactly the configurations with the least protection around them, the
 * endpoint that can read, write and RUN things in the user's cases was open to
 * any local process that found the port.
 *
 * So there is always a token: if the environment does not supply one, the server
 * mints its own on first use. The bridge is spawned by this same server process
 * and asks this same function, so the two halves agree without anything being
 * written to disk, and the endpoint can fail closed everywhere.
 *
 * It lives apart from src/lib/agent-policy.ts so that src/lib/claude-cli.ts can
 * ask for the token without pulling the whole policy — and with it wsl.ts and
 * the OpenFOAM index — into its module graph.
 */

import { randomBytes } from 'crypto';

let minted = '';

export function expectedToken(): string {
  if (process.env.OFSTUDIO_AGENT_TOKEN) return process.env.OFSTUDIO_AGENT_TOKEN;
  if (!minted) minted = randomBytes(24).toString('hex');
  return minted;
}
