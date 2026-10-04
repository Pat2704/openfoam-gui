/**
 * Is this `Host` header one the app itself is reached by?
 *
 * The server listens on loopback only, so every legitimate caller — the
 * Electron window, its health checks, the agent's MCP bridge, the dev server's
 * page — addresses it as 127.0.0.1 or localhost. A page that reached it through
 * DNS rebinding sends its own domain here instead. Any port is accepted: the
 * name is what tells the two apart.
 *
 * Pure and dependency-free so it can be tested; used by src/proxy.ts.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const match = /^(\[[0-9a-f:]+\]|[^:\s/@\[\]]+)(?::\d{1,5})?$/i.exec(host.trim());
  if (!match) return false;
  const name = match[1].toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}
