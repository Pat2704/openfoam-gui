interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Dynamic tool descriptions belong to a durable Codex thread and cannot be
 * replaced by thread/resume. Keep run_openfoam accurate after either direction
 * of a Guarded / No limits switch; the freshly applied base instructions name
 * which half is active, and the server still enforces that mode independently.
 */
export function codexDynamicTools(definitions: readonly ToolDefinition[]) {
  return definitions.map(tool => ({
    type: 'function', name: tool.name, inputSchema: tool.inputSchema,
    description: tool.name === 'run_openfoam'
      ? 'Run a command inside the selected case. Its behavior follows the current panel mode named in the instructions. '
        + 'In Guarded mode it accepts one installed OpenFOAM executable (or the documented mpirun form), validates options, '
        + 'and refuses shell syntax. In No limits mode it is a real WSL shell inside the case: pipes, redirects, chaining, '
        + 'moving and deleting work, while Windows paths under /mnt/ remain refused. Use background: true for long solves. '
        + 'Returns the exit code and the last lines of output.'
      : tool.description,
  }));
}
