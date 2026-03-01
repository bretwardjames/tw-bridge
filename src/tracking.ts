import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const TRACKING_FILE = path.join(os.homedir(), '.config', 'tw-bridge', 'tracking.json');

/** Map of trackingKey -> timew tags for that entry */
export type TrackingState = Record<string, string[]>;

export function loadTracking(): TrackingState {
  try {
    return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveTracking(state: TrackingState) {
  fs.mkdirSync(path.dirname(TRACKING_FILE), { recursive: true });
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(state));
}

export function mergedTags(state: TrackingState): string[] {
  const all = new Set<string>();
  for (const tags of Object.values(state)) {
    for (const tag of tags) all.add(tag);
  }
  return [...all];
}

export interface TimewInterval {
  start: string;
  end?: string;
  tags: string[];
}

export function getCurrentInterval(): TimewInterval | null {
  const result = spawnSync('timew', ['export'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || !result.stdout?.trim()) return null;

  try {
    const intervals: TimewInterval[] = JSON.parse(result.stdout);
    return intervals.find((iv) => !iv.end) ?? null;
  } catch {
    return null;
  }
}

/** Start a parallel entry: merge tags into current interval */
export function startParallel(key: string, tags: string[]) {
  const tracking = loadTracking();
  tracking[key] = tags;
  saveTracking(tracking);

  const merged = mergedTags(tracking);
  spawnSync('timew', ['stop'], { stdio: 'pipe' });
  spawnSync('timew', ['start', ...merged], { stdio: 'pipe' });
}

/** Start with switch: clear tracking, start fresh */
export function startSwitch(key: string, tags: string[]) {
  saveTracking({ [key]: tags });
  spawnSync('timew', ['stop'], { stdio: 'pipe' });
  spawnSync('timew', ['start', ...tags], { stdio: 'pipe' });
}

/** Stop an entry: remove from tracking, restart with remaining */
export function stopEntry(key: string) {
  const tracking = loadTracking();
  delete tracking[key];
  saveTracking(tracking);

  const remaining = mergedTags(tracking);
  spawnSync('timew', ['stop'], { stdio: 'pipe' });
  if (remaining.length > 0) {
    spawnSync('timew', ['start', ...remaining], { stdio: 'pipe' });
  }
}

/** Get all active meeting keys from tracking state */
export function getActiveMeetings(): Array<{ key: string; tags: string[] }> {
  const tracking = loadTracking();
  return Object.entries(tracking)
    .filter(([key]) => key.startsWith('meeting:'))
    .map(([key, tags]) => ({ key, tags }));
}
