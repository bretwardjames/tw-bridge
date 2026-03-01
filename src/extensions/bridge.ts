import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Timewarrior extension: `timew bridge`
 *
 * Receives filtered intervals on stdin (timew handles date filters like :day, :week).
 * Outputs task-time (per-task aggregation) and wall-time (merged intervals) reports.
 *
 * Usage:
 *   timew bridge                    Show both views
 *   timew bridge task-time          Per-task durations only
 *   timew bridge wall-time          Merged wall time only
 *   timew bridge ghp                Filter to intervals tagged "ghp"
 *   timew bridge task-time ragtime  Per-task for ragtime only
 *   timew bridge :day               Today only (timew handles the filter)
 *   timew bridge :week ghp          This week, ghp project only
 */

interface TimewInterval {
  start: string;
  end?: string;
  tags: string[];
}

interface TaskInfo {
  id: string;
  project: string;
  description: string;
  duration: number;
}

// --- Parsing ---

function parseInput(): TimewInterval[] {
  const raw = fs.readFileSync('/dev/stdin', 'utf-8');
  const lines = raw.split('\n');

  // Timewarrior sends config lines, then a blank line, then JSON
  let i = 0;
  while (i < lines.length && lines[i].trim() !== '') {
    i++;
  }
  i++; // skip blank line

  const json = lines.slice(i).join('\n').trim();
  if (!json) return [];

  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function parseTimewDate(s: string): Date {
  // Timewarrior uses YYYYMMDDTHHMMSSZ format
  return new Date(
    s.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'),
  );
}

function intervalDuration(iv: TimewInterval): number {
  const start = parseTimewDate(iv.start).getTime();
  const end = iv.end ? parseTimewDate(iv.end).getTime() : Date.now();
  return end - start;
}

// --- Formatting ---

function formatDuration(ms: number): string {
  const totalSecs = Math.round(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// --- Task description lookup ---

function lookupDescriptions(taskIds: string[]): Map<string, string> {
  const descriptions = new Map<string, string>();
  if (taskIds.length === 0) return descriptions;

  // Query Taskwarrior for tasks with these backend_ids
  const filter = taskIds.map((id) => `backend_id:${id}`).join(' or ');
  const result = spawnSync('task', ['rc.verbose=nothing', filter, 'export'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.status !== 0 || !result.stdout?.trim()) return descriptions;

  try {
    const tasks = JSON.parse(result.stdout);
    for (const t of tasks) {
      if (t.backend_id) {
        descriptions.set(t.backend_id, t.description ?? '');
      }
    }
  } catch {
    // Fall back to no descriptions
  }

  return descriptions;
}

// --- Computation ---

function computeTaskTime(intervals: TimewInterval[]): TaskInfo[] {
  const taskMap = new Map<string, { project: string; duration: number }>();

  for (const iv of intervals) {
    const duration = intervalDuration(iv);
    const idTag = iv.tags?.find((t) => t.startsWith('#'));
    const id = idTag?.slice(1) ?? '';
    const key = id || iv.tags?.join(' ') || 'untagged';

    // Use first tag that isn't the #id as project
    const project = iv.tags?.find((t) => !t.startsWith('#')) ?? '';

    const existing = taskMap.get(key);
    if (existing) {
      existing.duration += duration;
    } else {
      taskMap.set(key, { project, duration });
    }
  }

  // Look up descriptions from Taskwarrior
  const ids = [...taskMap.keys()].filter((k) => k !== 'untagged' && /^\d+$/.test(k));
  const descriptions = lookupDescriptions(ids);

  const tasks: TaskInfo[] = [];
  for (const [id, info] of taskMap) {
    tasks.push({
      id,
      project: info.project,
      description: descriptions.get(id) ?? '',
      duration: info.duration,
    });
  }

  return tasks.sort((a, b) => b.duration - a.duration);
}

function computeWallTime(intervals: TimewInterval[]): number {
  if (intervals.length === 0) return 0;

  const events: Array<{ time: number; type: 'start' | 'end' }> = [];

  for (const iv of intervals) {
    const start = parseTimewDate(iv.start).getTime();
    const end = iv.end ? parseTimewDate(iv.end).getTime() : Date.now();
    events.push({ time: start, type: 'start' });
    events.push({ time: end, type: 'end' });
  }

  // Sort by time; end before start at same time to avoid zero-width gaps
  events.sort((a, b) => a.time - b.time || (a.type === 'end' ? -1 : 1));

  let wallTime = 0;
  let depth = 0;
  let segmentStart = 0;

  for (const event of events) {
    if (event.type === 'start') {
      if (depth === 0) segmentStart = event.time;
      depth++;
    } else {
      depth--;
      if (depth === 0) {
        wallTime += event.time - segmentStart;
      }
    }
  }

  return wallTime;
}

function computeTimeline(intervals: TimewInterval[]): Array<{
  start: Date;
  end: Date;
  tags: string[];
}> {
  if (intervals.length === 0) return [];

  // Collect all transition points
  const points = new Set<number>();
  for (const iv of intervals) {
    points.add(parseTimewDate(iv.start).getTime());
    points.add(iv.end ? parseTimewDate(iv.end).getTime() : Date.now());
  }

  const sorted = [...points].sort((a, b) => a - b);
  const segments: Array<{ start: Date; end: Date; tags: string[] }> = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const segStart = sorted[i];
    const segEnd = sorted[i + 1];
    const midpoint = (segStart + segEnd) / 2;

    // Find all intervals active at this midpoint
    const activeTags: string[] = [];
    for (const iv of intervals) {
      const ivStart = parseTimewDate(iv.start).getTime();
      const ivEnd = iv.end ? parseTimewDate(iv.end).getTime() : Date.now();
      if (ivStart <= midpoint && ivEnd > midpoint) {
        for (const tag of iv.tags ?? []) {
          if (!activeTags.includes(tag)) activeTags.push(tag);
        }
      }
    }

    if (activeTags.length > 0) {
      segments.push({
        start: new Date(segStart),
        end: new Date(segEnd),
        tags: activeTags,
      });
    }
  }

  return segments;
}

// --- Output ---

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const LINE = '─'.repeat(60);

function printTaskTime(tasks: TaskInfo[], totalTask: number, wallTime: number) {
  console.log(`${BOLD}Task Time${RESET}`);
  console.log(LINE);

  for (const t of tasks) {
    const desc = t.description ? `  ${t.description}` : '';
    const idLabel = t.id ? `#${t.id}` : t.project;
    console.log(
      `  ${t.project.padEnd(14)} ${idLabel.padEnd(8)}${desc.padEnd(28)} ${formatDuration(t.duration).padStart(10)}`,
    );
  }

  console.log(LINE);
  console.log(`  ${'Total task time:'.padEnd(50)} ${BOLD}${formatDuration(totalTask).padStart(10)}${RESET}`);

  const overlap = totalTask - wallTime;
  if (overlap > 1000) {
    console.log(`  ${'Wall time:'.padEnd(50)} ${formatDuration(wallTime).padStart(10)}`);
    console.log(`  ${DIM}${'Overlap:'.padEnd(50)} ${formatDuration(overlap).padStart(10)}${RESET}`);
  }
}

function printWallTime(intervals: TimewInterval[]) {
  const timeline = computeTimeline(intervals);
  const wallTime = computeWallTime(intervals);

  console.log(`${BOLD}Wall Time${RESET}`);
  console.log(LINE);

  for (const seg of timeline) {
    const start = formatTime(seg.start);
    const end = formatTime(seg.end);
    const tags = seg.tags.join(', ');
    const duration = seg.end.getTime() - seg.start.getTime();
    console.log(
      `  ${start}–${end}  ${tags.padEnd(36)} ${DIM}${formatDuration(duration).padStart(10)}${RESET}`,
    );
  }

  console.log(LINE);
  console.log(`  ${'Total wall time:'.padEnd(50)} ${BOLD}${formatDuration(wallTime).padStart(10)}${RESET}`);
}

// --- Main ---

function main() {
  const args = process.argv.slice(2);
  const intervals = parseInput();

  let mode: 'both' | 'task-time' | 'wall-time' = 'both';
  const filters: string[] = [];

  for (const arg of args) {
    if (arg === 'task-time') mode = 'task-time';
    else if (arg === 'wall-time') mode = 'wall-time';
    else if (!arg.startsWith(':')) filters.push(arg); // skip timew hints like :day
  }

  // Filter intervals by tag if specified
  let filtered = intervals;
  if (filters.length > 0) {
    filtered = intervals.filter((iv) =>
      filters.some((f) => iv.tags?.includes(f)),
    );
  }

  if (filtered.length === 0) {
    console.log('No intervals found.');
    return;
  }

  if (mode === 'both' || mode === 'task-time') {
    const tasks = computeTaskTime(filtered);
    const totalTask = tasks.reduce((a, b) => a + b.duration, 0);
    const wallTime = computeWallTime(filtered);
    printTaskTime(tasks, totalTask, wallTime);
  }

  if (mode === 'both') console.log('');

  if (mode === 'both' || mode === 'wall-time') {
    printWallTime(filtered);
  }
}

main();
