import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Adapter } from '../adapter.js';
import type { TWTask, AdapterConfig } from '../types.js';

/** Shape of a single item from `ghp work --json` */
interface GhpWorkItem {
  number: number;
  title: string;
  type: string;
  issueType: string | null;
  status: string | null;
  state: string;
  assignees: string[];
  labels: Array<{ name: string; color: string }>;
  repository: string | null;
  url: string | null;
  fields: Record<string, string>;
  branch: string | null;
}

/**
 * Map GitHub Project status to a Taskwarrior tag (lowercase, underscored).
 */
function statusToTag(status: string | null): string | null {
  if (!status) return null;
  return status.toLowerCase().replace(/\s+/g, '_');
}

/**
 * Map GitHub priority field to Taskwarrior priority.
 */
function mapPriority(fields: Record<string, string>): 'H' | 'M' | 'L' | undefined {
  const priority = fields['Priority']?.toLowerCase();
  if (!priority) return undefined;
  if (priority.startsWith('high') || priority === 'urgent' || priority === 'p0' || priority === 'p1') return 'H';
  if (priority.startsWith('med') || priority === 'p2') return 'M';
  if (priority.startsWith('low') || priority === 'p3' || priority === 'p4') return 'L';
  return undefined;
}

/**
 * Extract a short, human-readable message from potentially verbose error output.
 * Strips stack traces, Node internals, and repeated lines.
 */
function extractErrorMessage(raw: string): string {
  const lines = raw.split('\n');

  // Look for "fatal:" (git errors) or "Error:" lines first
  const meaningful = lines.find(
    (l) => /^(fatal|error|Error):/i.test(l.trim()),
  );
  if (meaningful) return meaningful.trim();

  // Otherwise return the first non-empty line that isn't a stack frame or node internal
  const first = lines.find(
    (l) => l.trim() && !l.trim().startsWith('at ') && !l.includes('node:internal'),
  );
  return first?.trim() ?? raw.split('\n')[0].trim();
}

export interface GhpAdapterConfig extends AdapterConfig {
  /** Path to the git repo where `ghp work` should run */
  cwd: string;
  /** Taskwarrior project name to assign (defaults to repo name) */
  project?: string;
}

export class GhpAdapter implements Adapter {
  readonly name = 'ghp';
  private config!: GhpAdapterConfig;

  defaultConfig(cwd: string): AdapterConfig {
    return {
      cwd,
      project: path.basename(cwd),
    };
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = config as GhpAdapterConfig;
    if (!this.config.cwd) {
      throw new Error('ghp adapter requires "cwd" in config (path to git repo)');
    }
  }

  async pull(): Promise<TWTask[]> {
    const result = spawnSync('ghp', ['work', '--json'], {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    if (result.status !== 0 || !result.stdout?.trim()) {
      const raw = result.stderr?.trim() || result.stdout?.trim() || 'unknown error';
      console.error(`  Warning: ${extractErrorMessage(raw)}`);
      return [];
    }

    let items: GhpWorkItem[];
    try {
      items = JSON.parse(result.stdout);
    } catch {
      console.error(`  Warning: ${extractErrorMessage(result.stdout.trim())}`);
      return [];
    }
    const tasks: TWTask[] = [];

    for (const item of items) {
      const statusTag = statusToTag(item.status);
      const tags: string[] = [];
      if (statusTag) tags.push(statusTag);

      // Add label tags
      for (const label of item.labels) {
        tags.push(label.name.toLowerCase().replace(/\s+/g, '_'));
      }

      // Derive project name: config override, or repo name
      const project =
        this.config.project ??
        item.repository?.split('/')[1] ??
        undefined;

      const task: TWTask = {
        uuid: '',
        description: item.title,
        status: 'pending',
        entry: new Date().toISOString(),
        project,
        tags,
        priority: mapPriority(item.fields),
        // backend and backend_id are set by the sync layer
        backend: '',
        backend_id: String(item.number),
        annotations: item.url
          ? [{ entry: new Date().toISOString(), description: item.url }]
          : undefined,
      };

      tasks.push(task);
    }

    return tasks;
  }

  async onStart(task: TWTask, ttyFd: number): Promise<void> {
    const issueNumber = task.backend_id;
    if (!issueNumber) {
      process.stderr.write('tw-bridge [ghp]: task has no backend_id, skipping ghp start\n');
      return;
    }

    process.stderr.write(`tw-bridge [ghp]: starting issue #${issueNumber}\n`);

    const result = spawnSync('ghp', ['start', issueNumber], {
      cwd: this.config.cwd,
      stdio: [ttyFd, ttyFd, ttyFd],
    });

    if (result.status !== 0) {
      throw new Error(`ghp start exited with code ${result.status}`);
    }
  }

  async onDone(task: TWTask): Promise<void> {
    const issueNumber = task.backend_id;
    if (!issueNumber) return;

    process.stderr.write(`tw-bridge [ghp]: completing issue #${issueNumber}\n`);

    const result = spawnSync('ghp', ['done', issueNumber], {
      cwd: this.config.cwd,
      stdio: 'pipe',
    });

    if (result.status !== 0) {
      throw new Error(`ghp done exited with code ${result.status}`);
    }
  }
}
