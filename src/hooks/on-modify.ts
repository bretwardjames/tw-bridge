import fs from 'node:fs';
import { loadConfig } from '../config.js';
import { resolveAdapter } from '../registry.js';
import type { TWTask } from '../types.js';

async function main() {
  // Taskwarrior protocol: stdin line 1 = original task, line 2 = modified task
  const input = fs.readFileSync('/dev/stdin', 'utf-8').trim().split('\n');
  const oldTask: TWTask = JSON.parse(input[0]);
  const newTask: TWTask = JSON.parse(input[1]);

  // Output modified task immediately — Taskwarrior reads this first.
  // Everything after this goes to the user as feedback.
  process.stdout.write(JSON.stringify(newTask) + '\n');

  const config = loadConfig();
  const adapter = await resolveAdapter(newTask, config);
  if (!adapter) return;

  // Detect lifecycle transitions
  const wasStarted = !oldTask.start && !!newTask.start;
  const wasStopped = !!oldTask.start && !newTask.start && newTask.status === 'pending';
  const wasCompleted = oldTask.status !== 'completed' && newTask.status === 'completed';

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
