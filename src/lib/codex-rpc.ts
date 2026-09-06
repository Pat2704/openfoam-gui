import type { ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';

/** Exported for transport tests with a fake child; no tool execution in this class. */
export class Rpc {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private dead = false;
  private child: ChildProcessWithoutNullStreams;
  private message: (msg: any) => void;
  private stopped: (error: Error) => void;
  constructor(child: ChildProcessWithoutNullStreams, message: (msg: any) => void,
    stopped: (error: Error) => void) {
    this.child = child; this.message = message; this.stopped = stopped;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.method) { this.message(msg); return; }
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message || 'Codex request failed.'));
      else pending.resolve(msg.result);
    });
    // Never log protocol frames, credentials or the sign-in URL.
    child.stderr.resume();
    child.stdin.on('error', e => this.fail(e));
    child.on('error', e => this.fail(e));
    child.on('exit', (code, signal) => this.fail(new Error(`Codex stopped (${signal || code}). Send another message to reconnect.`)));
  }
  private fail(error: Error) {
    if (this.dead) return; this.dead = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.stopped(error);
  }
  write(msg: unknown) { if (!this.dead) this.child.stdin.write(JSON.stringify(msg) + '\n'); }
  request(method: string, params: unknown = {}, timeout = 60000): Promise<any> {
    if (this.dead) return Promise.reject(new Error('Codex is not connected.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  close() { this.fail(new Error('Codex connection closed.')); this.child.stdin.end(); const child = this.child;
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1500).unref(); }
}

