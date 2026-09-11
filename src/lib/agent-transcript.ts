export type AgentTranscriptBlock =
  | { kind: 'text'; id?: string; text: string; live: boolean; snapshot?: string }
  | { kind: 'thinking'; id?: string; text: string; live: boolean; snapshot?: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; status: 'running' | 'ok' | 'error'; result: string };

/**
 * Fold one provider event into the blocks displayed for an assistant turn.
 *
 * Claude and Codex both stream deltas and later send an authoritative snapshot.
 * Providers may replay that snapshot, especially around a tool call. Block IDs
 * handle literal replays; cumulative snapshots sometimes arrive under a fresh
 * ID, so their already-rendered prefix is removed as well.
 */
export function applyAgentTranscriptEvent(
  previous: AgentTranscriptBlock[],
  event: Record<string, unknown>,
): AgentTranscriptBlock[] {
  const blocks = [...previous];
  const type = event.t;
  const id = typeof event.id === 'string' && event.id ? event.id : undefined;

  const findTextBlock = (channel: 'text' | 'thinking', liveOnly: boolean): number => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block.kind !== channel || (liveOnly && !block.live)) continue;
      if (!id || block.id === id) return i;
    }
    return -1;
  };

  const closeLive = () => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if ((block.kind === 'text' || block.kind === 'thinking') && block.live) {
        blocks[i] = { ...block, live: false };
        break;
      }
    }
  };

  const previousFinal = (channel: 'text' | 'thinking', before: number): number => {
    for (let i = before - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block.kind === channel && !block.live) return i;
    }
    return -1;
  };

  if (type === 'block_start') {
    const channel = event.channel as 'text' | 'thinking';
    const existing = id ? findTextBlock(channel, false) : -1;
    if (existing < 0) blocks.push({ kind: channel, id, text: '', live: true });
  } else if (type === 'delta') {
    const channel = event.channel as 'text' | 'thinking';
    let index = findTextBlock(channel, true);
    // A late replay must not append deltas to a block already finalised.
    if (index < 0 && id && findTextBlock(channel, false) >= 0) return blocks;
    if (index < 0) {
      blocks.push({ kind: channel, id, text: String(event.text || ''), live: true });
    } else {
      const block = blocks[index] as Extract<AgentTranscriptBlock, { kind: 'text' | 'thinking' }>;
      blocks[index] = { ...block, text: block.text + String(event.text || '') };
    }
  } else if (type === 'block_end') {
    const channel = event.channel as 'text' | 'thinking';
    const text = String(event.text || '');
    let index = findTextBlock(channel, id ? false : true);
    if (index < 0 && !id) {
      // Compatibility with an older provider event that has no ID: only a
      // directly repeated snapshot is safe to collapse.
      const last = blocks.at(-1);
      if (last?.kind === channel && !last.live && last.text === text) return blocks;
      index = findTextBlock(channel, true);
    }
    const priorIndex = previousFinal(channel, index >= 0 ? index : blocks.length);
    const prior = priorIndex >= 0
      ? blocks[priorIndex] as Extract<AgentTranscriptBlock, { kind: 'text' | 'thinking' }>
      : undefined;
    const priorSnapshot = prior?.snapshot ?? prior?.text ?? '';

    // Claude and Codex can publish A, then A+B, then A+B+C as separate
    // completed items around tool calls. Preserve the tool ordering, but show
    // only the new suffix instead of rendering the growing prefix each time.
    if (priorSnapshot && text.length > priorSnapshot.length && text.startsWith(priorSnapshot)) {
      if (index >= 0 && priorIndex === index - 1) {
        blocks.splice(priorIndex, 2, { kind: channel, id, text, live: false });
      } else if (index < 0 && priorIndex === blocks.length - 1) {
        blocks[priorIndex] = { kind: channel, id, text, live: false };
      } else {
        const suffix = text.slice(priorSnapshot.length).replace(/^(?:\r?\n)+/, '');
        const next = { kind: channel, id: id ?? (index >= 0 ? blocks[index].id : undefined), text: suffix, live: false, snapshot: text } as const;
        if (index >= 0) blocks[index] = next;
        else blocks.push(next);
      }
    } else if (index >= 0) {
      blocks[index] = { kind: channel, id: id ?? blocks[index].id, text, live: false };
    } else {
      blocks.push({ kind: channel, id, text, live: false });
    }
  } else if (type === 'tool_use') {
    closeLive();
    const toolId = String(event.id || '');
    const existing = toolId ? blocks.findIndex(block => block.kind === 'tool' && block.id === toolId) : -1;
    if (existing < 0) {
      blocks.push({
        kind: 'tool', id: toolId, name: String(event.name || ''),
        input: (event.input || {}) as Record<string, unknown>, status: 'running', result: '',
      });
    }
  } else if (type === 'tool_result') {
    const index = blocks.findIndex(block => block.kind === 'tool' && block.id === event.id);
    if (index >= 0) {
      const block = blocks[index] as Extract<AgentTranscriptBlock, { kind: 'tool' }>;
      blocks[index] = { ...block, status: event.ok === false ? 'error' : 'ok', result: String(event.text || '') };
    }
  } else if (type === 'done') {
    closeLive();
  }

  return blocks;
}
