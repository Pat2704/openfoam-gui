/** The deliberately small part of app-server used by the OpenFOAM panel. */
export interface CodexModel {
  id: string;
  label: string;
  hint: string;
  effort: boolean;
  isDefault: boolean;
  defaultEffort: string;
  efforts: { id: string; label: string; hint: string }[];
}

export function modelChoices(data: unknown): CodexModel[] {
  if (!Array.isArray(data)) return [];
  return data.filter(m => m && typeof m.model === 'string' && !m.hidden).map(m => {
    const efforts = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
      .filter((e: any) => typeof e.reasoningEffort === 'string')
      .map((e: any) => ({ id: e.reasoningEffort, label: e.reasoningEffort, hint: e.description || '' }));
    return { id: m.model, label: m.displayName || m.model, hint: m.description || '',
      effort: efforts.length > 0, isDefault: m.isDefault === true,
      defaultEffort: m.defaultReasoningEffort || efforts[0]?.id || 'medium', efforts };
  });
}

// No environment means no native filesystem/terminal tools. These overrides also
// turn off independent tool sources: a prompt saying "use only our tools" is NOT
// confinement. The app-server lives in its own home, with no user config/plugins.
export const CODEX_CONFIG: Record<string, unknown> = {
  model_provider: 'openai', forced_login_method: 'chatgpt',
  web_search: 'disabled', approval_policy: 'never', sandbox_mode: 'read-only',
  project_doc_max_bytes: 0, mcp_servers: {}, hooks: {},
  'orchestrator.skills.enabled': false, 'orchestrator.mcp.enabled': false,
  'tools.experimental_request_user_input.enabled': false,
  'apps._default.enabled': false,
  'features.shell_tool': false, 'features.unified_exec': false,
  'features.apply_patch_freeform': false, 'features.code_mode': false,
  'features.code_mode_only': false, 'features.js_repl': false,
  'features.view_image': false, 'features.image_generation': false,
  'features.imagegenext': false, 'features.apps': false, 'features.connectors': false,
  'features.plugins': false, 'features.remote_plugin': false,
  'features.multi_agent': false, 'features.multi_agent_v2': false,
  'features.collab': false, 'features.collaboration_modes': false,
  'features.browser_use': false, 'features.computer_use': false,
  'features.in_app_browser': false, 'features.hooks': false, 'features.codex_hooks': false,
  'features.plugin_hooks': false, 'features.memories': false, 'features.memory_tool': false,
  'features.skip_host_skill_discovery': true, 'features.skill_search': false,
  'features.shell_snapshot': false, 'features.request_permissions': false,
  'features.request_permissions_tool': false, 'features.tool_search': false,
  'features.tool_suggest': false, 'features.search_tool': false,
  'features.goals': false, 'features.sleep_tool': false, 'features.undo': false,
};

export type PanelEvent = Record<string, unknown> & { t: string };

/** Only completed text is authoritative; summaries are the public reasoning. */
export function panelEvents(method: string, p: any): PanelEvent[] {
  if (method === 'item/agentMessage/delta') return [{ t: 'delta', channel: 'text', text: p.delta }];
  if (method === 'item/reasoning/summaryTextDelta') return [{ t: 'delta', channel: 'thinking', text: p.delta }];
  const item = p.item;
  if (method === 'item/started') {
    if (item?.type === 'agentMessage') return [{ t: 'block_start', channel: 'text' }];
    if (item?.type === 'reasoning') return [{ t: 'block_start', channel: 'thinking' }];
  }
  if (method === 'item/completed') {
    if (item?.type === 'agentMessage') return [{ t: 'block_end', channel: 'text', text: item.text || '' }];
    if (item?.type === 'reasoning') return [{ t: 'block_end', channel: 'thinking', text: (item.summary || []).join('\n') }];
  }
  if (method === 'error' && !p.willRetry) return [{ t: 'error', message: p.error?.message || 'Codex failed.' }];
  return [];
}
