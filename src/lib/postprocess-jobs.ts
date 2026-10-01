import { randomUUID } from 'crypto';
import { WslInputError } from './wsl-input';

export type PostProcessJobStatus = 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';

export interface PostProcessJob {
  id: string;
  caseName: string;
  installationId: string;
  spec: string;
  status: PostProcessJobStatus;
  startedAt: number;
  finishedAt: number | null;
  output: string;
  outputTruncated: boolean;
  command: string;
  exitCode: number | null;
}

export interface PostProcessTask {
  completion: Promise<{ exitCode: number; command: string }>;
  cancel: () => Promise<void>;
}

const OUTPUT_LIMIT = 256 * 1024;
const RETAINED_JOBS = 32;

/** Jobs are scoped to the installation that started them, even after a distro switch. */
export class PostProcessJobs {
  private jobs = new Map<string, { job: PostProcessJob; task: PostProcessTask }>();

  start(
    caseName: string, installationId: string, spec: string,
    launch: (output: (chunk: string) => void) => PostProcessTask,
  ): PostProcessJob {
    if ([...this.jobs.values()].some(({ job }) => job.caseName === caseName
      && job.installationId === installationId && ['running', 'cancelling'].includes(job.status))) {
      throw new WslInputError('A post-processing job is already running for this case.');
    }
    for (const [id, { job }] of this.jobs) {
      if (this.jobs.size < RETAINED_JOBS) break;
      if (job.finishedAt !== null) this.jobs.delete(id);
    }
    if (this.jobs.size >= RETAINED_JOBS) throw new WslInputError('Too many post-processing jobs are running.');
    const job: PostProcessJob = {
      id: randomUUID(), caseName, installationId, spec, status: 'running',
      startedAt: Date.now(), finishedAt: null, output: '', outputTruncated: false,
      command: '', exitCode: null,
    };
    const append = (chunk: string) => {
      const combined = job.output + chunk;
      job.outputTruncated ||= combined.length > OUTPUT_LIMIT;
      job.output = combined.slice(-OUTPUT_LIMIT);
    };
    const task = launch(append);
    this.jobs.set(job.id, { job, task });
    void task.completion.then(result => {
      job.exitCode = result.exitCode;
      job.command = result.command;
      job.status = job.status === 'cancelling' ? 'cancelled' : result.exitCode === 0 ? 'done' : 'failed';
    }, error => {
      append(`\n${error instanceof Error ? error.message : 'Post-processing failed'}\n`);
      job.status = job.status === 'cancelling' ? 'cancelled' : 'failed';
    }).finally(() => { job.finishedAt = Date.now(); });
    return { ...job };
  }

  get(caseName: string, installationId: string, id?: string): PostProcessJob | null {
    const found = id ? this.jobs.get(id)?.job
      : [...this.jobs.values()].reverse().find(({ job }) => job.caseName === caseName
        && job.installationId === installationId)?.job;
    if (!found) return null;
    if (found.caseName !== caseName || found.installationId !== installationId) {
      throw new WslInputError('This post-processing job belongs to another case or installation.');
    }
    return { ...found };
  }

  async cancel(caseName: string, installationId: string, id: string): Promise<PostProcessJob> {
    const job = this.get(caseName, installationId, id);
    if (!job) throw new WslInputError('This post-processing job is no longer available.');
    const entry = this.jobs.get(job.id)!;
    if (entry.job.status === 'running') {
      entry.job.status = 'cancelling';
      try {
        await entry.task.cancel();
      } catch (error) {
        if (entry.job.status === 'cancelling') entry.job.status = 'running';
        throw error;
      }
    }
    return { ...entry.job };
  }
}

// A hot-reloaded route must not lose the handle to an owned WSL process.
const shared = globalThis as typeof globalThis & { openFoamPostProcessJobs?: PostProcessJobs };
export const postProcessJobs = shared.openFoamPostProcessJobs ??= new PostProcessJobs();
