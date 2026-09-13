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
      const delta = String(event.text || '');
      const source = block.snapshot ?? block.text;
      // A few provider versions have sent a growing snapshot in one `delta`;
      // the normal protocol sends the small incremental pieces seen below.
      const raw = source && delta.length > source.length && delta.startsWith(source)
        ? delta
        : source + delta;
      const priorIndex = previousFinal(channel, index);
      const prior = priorIndex >= 0
        ? blocks[priorIndex] as Extract<AgentTranscriptBlock, { kind: 'text' | 'thinking' }>
        : undefined;
      const priorSource = prior?.snapshot ?? prior?.text ?? '';
      const toolBetween = priorIndex >= 0 && blocks
        .slice(priorIndex + 1, index)
        .some(candidate => candidate.kind === 'tool');

      // The real multi-tool stream starts each fresh message from the complete
      // summary already rendered before the tool, then adds one fact. Hide that
      // known prefix while it is reconstructed and retain `raw` separately so
      // following token deltas still append to the provider's complete block.
      if (toolBetween && priorSource && (priorSource.startsWith(raw) || raw.startsWith(priorSource))) {
        const text = raw.length > priorSource.length
          ? raw.slice(priorSource.length).replace(/^(?:\r?\n)+/, '')
          : '';
        blocks[index] = { ...block, text, snapshot: raw };
      } else {
        blocks[index] = block.snapshot === undefined
          ? { ...block, text: raw }
          : { ...block, text: raw, snapshot: raw };
      }
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
    const toolBetween = priorIndex >= 0 && blocks
      .slice(priorIndex + 1, index >= 0 ? index : blocks.length)
      .some(candidate => candidate.kind === 'tool');

    // Claude and Codex can publish A, then A+B, then A+B+C as separate
    // completed items around tool calls. Preserve the tool ordering, but show
    // only the new suffix instead of rendering the growing prefix each time.
    if (toolBetween && priorSnapshot && text === priorSnapshot) {
      // A fresh provider item can be only a replay of the previous cumulative
      // summary. It contributes no visible text, but tools between the two stay.
      if (index >= 0) blocks.splice(index, 1);
    } else if (priorSnapshot && text.length > priorSnapshot.length && text.startsWith(priorSnapshot)) {
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
    const finalText = typeof event.text === 'string' ? event.text : '';
    if (finalText) {
      // Provider deltas and message snapshots are only a live preview. Claude's
      // result and Codex's last completed agent message are the authoritative
      // answer for the turn. Rebuild the text portion from that one value so a
      // sequence such as A, A+B, A+B+C can never survive into the finished UI.
      const nonText = blocks.filter(block => block.kind !== 'text');
      blocks.splice(0, blocks.length, ...nonText, {
        kind: 'text', text: finalText, live: false,
      });
    } else {
      // A failed/interrupted turn may have no authoritative result. Do not
      // discard its useful partial output, but ensure no typing cursor remains.
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if ((block.kind === 'text' || block.kind === 'thinking') && block.live) {
          blocks[i] = { ...block, live: false };
        }
      }
    }
  }

  return blocks;
}
