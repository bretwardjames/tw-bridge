import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../config.js';
import { resolveAdapter } from '../registry.js';
import {
  loadTracking,
  saveTracking,
  mergedTags,
  getCurrentInterval,
  type TimewInterval,
} from '../tracking.js';
import type { TWTask, BridgeConfig } from '../types.js';

// --- Timewarrior helpers ---

function timewTags(task: TWTask): string[] {
  const tags: string[] = [];
  if (task.backend) tags.push(task.backend);
  if (task.backend_id) tags.push(`#${task.backend_id}`);
  if (task.project) tags.push(task.project);
  for (const tag of task.tags ?? []) {
    if (!tag.includes('_')) tags.push(tag);
  }
  return [...new Set(tags)];
}

function taskKey(task: TWTask): string {
  return task.backend_id ? `#${task.backend_id}` : task.uuid;
}

function formatDuration(isoStart: string): string {
  const start = new Date(
    isoStart.replace(
      /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
      '$1-$2-$3T$4:$5:$6Z',
    ),
  );
  const mins = Math.round((Date.now() - start.getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Check if current tracking and new task share a project.
 * Non-#id tags are considered "project" identifiers.
 */
function isSameProject(currentTags: string[], newTags: string[]): boolean {
  const currentProjects = new Set(currentTags.filter((t) => !t.startsWith('#')));
  return newTags.some((t) => !t.startsWith('#') && currentProjects.has(t));
}

/**
 * Prompt via /dev/tty: switch or parallel?
 * Shows what's currently tracking and how long it's been running.
 */
function promptTimewMode(
  ttyFd: number,
  current: TimewInterval,
): 'switch' | 'parallel' {
  const duration = formatDuration(current.start);
  const tags = current.tags.join(' ');

  const lines: string[] = [
    `\ntw-bridge: Currently tracking: ${tags} (${duration})`,
  ];

  // Warn if stale
  const startTime = new Date(
    current.start.replace(
      /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
      '$1-$2-$3T$4:$5:$6Z',
    ),
  );
  const hours = (Date.now() - startTime.getTime()) / 3600000;
  if (hours >= 4) {
    lines.push(`  Warning: this has been running for ${duration}`);
  }

  lines.push('');
  lines.push('  [s] Switch — stop current, start new task (default)');
  lines.push('  [p] Parallel — add new task to current tracking');
  lines.push('');

  fs.writeSync(ttyFd, lines.join('\n'));
  fs.writeSync(ttyFd, '  > ');

  const buf = Buffer.alloc(64);
  const bytesRead = fs.readSync(ttyFd, buf, 0, 64, null);
  const answer = buf.toString('utf-8', 0, bytesRead).trim().toLowerCase();

  return answer.startsWith('p') ? 'parallel' : 'switch';
}

// --- Timewarrior lifecycle ---

function handleTimewarriorStart(
  config: BridgeConfig,
  newTask: TWTask,
  ttyFd: number | null,
) {
  if (!config.timewarrior?.enabled) return;

  const mode = process.env.TW_BRIDGE_MODE ?? '';
  const tracking = loadTracking();
  const current = getCurrentInterval();
  const newTags = timewTags(newTask);
  const key = taskKey(newTask);

  let resolvedMode = mode;

  // Decide mode if not passed via flag
  if (current && !resolvedMode) {
    if (isSameProject(current.tags, newTags)) {
      // Same project → auto-switch (just moving to a different task)
      resolvedMode = 'switch';
    } else if (ttyFd !== null) {
      // Different project → ask
      resolvedMode = promptTimewMode(ttyFd, current);
    } else {
      resolvedMode = 'switch';
    }
  }

  if (resolvedMode === 'parallel') {
    // Add to tracking, merge all tags, restart interval
    tracking[key] = newTags;
    saveTracking(tracking);

    const merged = mergedTags(tracking);
    spawnSync('timew', ['stop'], { stdio: 'pipe' });
    spawnSync('timew', ['start', ...merged], { stdio: 'pipe' });
  } else {
    // Switch: clear tracking, start fresh with just this task
    saveTracking({ [key]: newTags });

    spawnSync('timew', ['stop'], { stdio: 'pipe' });
    spawnSync('timew', ['start', ...newTags], { stdio: 'pipe' });
  }
}

function handleTimewarriorStop(config: BridgeConfig, task: TWTask) {
  if (!config.timewarrior?.enabled) return;

  const tracking = loadTracking();
  const key = taskKey(task);

  // Remove this task from tracking
  delete tracking[key];
  saveTracking(tracking);

  const remaining = mergedTags(tracking);

  // Stop current interval
  spawnSync('timew', ['stop'], { stdio: 'pipe' });

  // Restart with remaining tasks if any are still active
  if (remaining.length > 0) {
    spawnSync('timew', ['start', ...remaining], { stdio: 'pipe' });
  }
}

// --- Main ---

async function main() {
  const input = fs.readFileSync('/dev/stdin', 'utf-8').trim().split('\n');
  const oldTask: TWTask = JSON.parse(input[0]);
  const newTask: TWTask = JSON.parse(input[1]);

  // Taskwarrior protocol: output modified task immediately
  process.stdout.write(JSON.stringify(newTask) + '\n');

  const config = loadConfig();

  const wasStarted = !oldTask.start && !!newTask.start;
  const wasStopped =
    !!oldTask.start && !newTask.start && newTask.status === 'pending';
  const wasCompleted =
    oldTask.status !== 'completed' && newTask.status === 'completed';

  // Open /dev/tty early — needed for both timew prompt and adapter onStart
  let ttyFd: number | null = null;
  if (wasStarted) {
    try {
      ttyFd = fs.openSync('/dev/tty', 'r+');
    } catch {
      // No tty available (e.g., running from a script)
    }
  }

  try {
    // Handle Timewarrior tracking
    if (wasStarted) {
      handleTimewarriorStart(config, newTask, ttyFd);
    } else if (wasStopped || wasCompleted) {
      handleTimewarriorStop(config, oldTask);
    }

    // Skip adapter calls during reverse-sync (e.g., tw-bridge start ghp#123)
    if (process.env.TW_BRIDGE_REVERSE_SYNC) return;

    // Route to backend adapter
    const adapter = await resolveAdapter(newTask, config);
    if (!adapter) return;

    if (wasStarted && adapter.onStart) {
      if (ttyFd !== null) {
        await adapter.onStart(newTask, ttyFd);
      }
    } else if (wasStopped && adapter.onStop) {
      await adapter.onStop(newTask);
    } else if (wasCompleted && adapter.onDone) {
      await adapter.onDone(newTask);
    } else if (adapter.onModify) {
      await adapter.onModify(oldTask, newTask);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tw-bridge: ${msg}\n`);
  } finally {
    if (ttyFd !== null) fs.closeSync(ttyFd);
  }
}

main();
