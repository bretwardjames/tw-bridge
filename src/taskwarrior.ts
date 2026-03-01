import { spawnSync } from 'node:child_process';
import type { TWTask } from './types.js';

/**
 * Query existing Taskwarrior tasks by backend and backend_id.
 * Returns a map of backend_id -> existing task.
 */
export function getExistingTasks(backend: string): Map<string, TWTask> {
  const result = spawnSync(
    'task',
    ['backend:' + backend, 'status:pending', 'export'],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  if (result.status !== 0) {
    // If no tasks match, task export returns non-zero — that's fine
    return new Map();
  }

  const tasks: TWTask[] = JSON.parse(result.stdout || '[]');
  const map = new Map<string, TWTask>();
  for (const task of tasks) {
    if (task.backend_id) {
      map.set(task.backend_id, task);
    }
  }
  return map;
}

/**
 * Import a new task into Taskwarrior via `task import`.
 */
export function importTask(task: TWTask): { uuid: string } {
  // Remove empty uuid — Taskwarrior will assign one
  const { uuid: _, ...taskData } = task;

  const result = spawnSync('task', ['import'], {
    input: JSON.stringify(taskData),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(`task import failed: ${result.stderr?.trim()}`);
  }

  // task import outputs "Importing task <uuid>." or similar
  const match = result.stdout?.match(/([0-9a-f-]{36})/);
  return { uuid: match?.[1] ?? 'unknown' };
}

/**
 * Update an existing task's tags (replace status tags with new one).
 * Only updates if there's actually a change.
 */
export function updateTaskTags(
  existing: TWTask,
  newTags: string[],
): boolean {
  const existingTags = new Set(existing.tags ?? []);
  const targetTags = new Set(newTags);

  // Check if tags differ
  if (
    existingTags.size === targetTags.size &&
    [...existingTags].every((t) => targetTags.has(t))
  ) {
    return false; // No change
  }

  // Build modify args: remove old tags, add new tags
  const args = ['task', existing.uuid, 'modify'];

  // Remove tags not in new set
  for (const tag of existingTags) {
    if (!targetTags.has(tag)) args.push(`-${tag}`);
  }
  // Add tags not in existing set
  for (const tag of targetTags) {
    if (!existingTags.has(tag)) args.push(`+${tag}`);
  }

  const result = spawnSync(args[0], args.slice(1), {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return result.status === 0;
}

/**
 * Ensure a Taskwarrior context exists for a backend.
 * Uses the match rule's tags to build the filter.
 */
export function ensureContext(
  name: string,
  tags: string[],
): boolean {
  // Check if context already exists
  const check = spawnSync('task', ['context', 'show'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const existing = check.stdout ?? '';
  // `task context list` is more reliable but `task context define` is idempotent
  // so just define it — if it exists it gets updated
  const filter = tags.map((t) => `+${t}`).join(' or ');

  // Taskwarrior 3.x: task context define <name> <filter>
  // Needs rc.confirmation=off to avoid interactive prompt
  const result = spawnSync(
    'task',
    ['rc.confirmation=off', 'context', 'define', name, filter],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  return result.status === 0;
}

/**
 * Mark a task as completed via `task done`.
 * Strips all status tags first, keeping only the provided keepTags.
 */
export function completeTask(existing: TWTask, keepTags: string[]): boolean {
  const keep = new Set(keepTags);
  const removals = (existing.tags ?? [])
    .filter((t) => !keep.has(t))
    .map((t) => `-${t}`);

  const args = ['rc.confirmation=off', existing.uuid, 'modify', ...removals];

  if (removals.length > 0) {
    spawnSync('task', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  const result = spawnSync(
    'task',
    ['rc.confirmation=off', existing.uuid, 'done'],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  return result.status === 0;
}

/**
 * Update a task's description if it changed.
 */
export function updateTaskDescription(
  existing: TWTask,
  newDescription: string,
): boolean {
  if (existing.description === newDescription) return false;

  const result = spawnSync(
    'task',
    [existing.uuid, 'modify', `description:${newDescription}`],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  return result.status === 0;
}
