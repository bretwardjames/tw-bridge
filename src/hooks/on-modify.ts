import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../config.js';
import { resolveAdapter } from '../registry.js';
import type { TWTask, BridgeConfig } from '../types.js';

/**
 * Build Timewarrior tags from a task.
 * Uses: backend name, backend_id, project, and TW tags.
 */
function timewTags(task: TWTask): string[] {
  const tags: string[] = [];
  if (task.backend) tags.push(task.backend);
  if (task.backend_id) tags.push(`#${task.backend_id}`);
  if (task.project) tags.push(task.project);
  // Include TW tags except status tags (those change frequently)
  for (const tag of task.tags ?? []) {
    if (!tag.includes('_')) tags.push(tag); // status tags have underscores
  }
  return [...new Set(tags)]; // deduplicate
}

function handleTimewarrior(
  config: BridgeConfig,
  oldTask: TWTask,
  newTask: TWTask,
  wasStarted: boolean,
  wasStopped: boolean,
  wasCompleted: boolean,
) {
  const twConfig = config.timewarrior;
  if (!twConfig?.enabled) return;

  const overlap = twConfig.allow_overlaps ?? false;

  if (wasStarted) {
    const tags = timewTags(newTask);
    const args = ['start', ...tags];
    if (overlap) args.splice(1, 0, ':overlap');

    spawnSync('timew', args, { stdio: 'pipe' });
  } else if (wasStopped || wasCompleted) {
    // Stop tracking this specific task
    // timew stop just stops the current interval, but with overlaps
    // we might have multiple running. Use tags to identify.
    const tags = timewTags(oldTask);

    if (overlap) {
      // With overlaps, we need to stop the specific interval.
      // `timew stop <tags>` stops the interval matching those tags.
      spawnSync('timew', ['stop', ...tags], { stdio: 'pipe' });
    } else {
      spawnSync('timew', ['stop'], { stdio: 'pipe' });
    }
  }
}

async function main() {
  // Taskwarrior protocol: stdin line 1 = original task, line 2 = modified task
  const input = fs.readFileSync('/dev/stdin', 'utf-8').trim().split('\n');
  const oldTask: TWTask = JSON.parse(input[0]);
  const newTask: TWTask = JSON.parse(input[1]);

  // Output modified task immediately — Taskwarrior reads this first.
  process.stdout.write(JSON.stringify(newTask) + '\n');

  const config = loadConfig();

  // Detect lifecycle transitions
  const wasStarted = !oldTask.start && !!newTask.start;
  const wasStopped = !!oldTask.start && !newTask.start && newTask.status === 'pending';
  const wasCompleted = oldTask.status !== 'completed' && newTask.status === 'completed';

  // Handle Timewarrior tracking
  handleTimewarrior(config, oldTask, newTask, wasStarted, wasStopped, wasCompleted);

  // Route to backend adapter
  const adapter = await resolveAdapter(newTask, config);
  if (!adapter) return;

  let ttyFd: number | null = null;

  try {
    if (wasStarted && adapter.onStart) {
      ttyFd = fs.openSync('/dev/tty', 'r+');
      await adapter.onStart(newTask, ttyFd);
    } else if (wasStopped && adapter.onStop) {
      await adapter.onStop(newTask);
    } else if (wasCompleted && adapter.onDone) {
      await adapter.onDone(newTask);
    } else if (adapter.onModify) {
      await adapter.onModify(oldTask, newTask);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tw-bridge [${adapter.name}]: ${msg}\n`);
  } finally {
    if (ttyFd !== null) fs.closeSync(ttyFd);
  }
}

main();
