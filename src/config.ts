import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { BridgeConfig } from './types.js';

const CONFIG_PATHS = [
  path.join(os.homedir(), '.config', 'tw-bridge', 'config.json'),
  path.join(os.homedir(), '.tw-bridge.json'),
];

export function findConfigPath(): string | null {
  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function loadConfig(): BridgeConfig {
  const configPath = findConfigPath();
  if (!configPath) {
    return { backends: {} };
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as BridgeConfig;
}

/**
 * Save config to the preferred path (first in CONFIG_PATHS).
 * Creates the directory if it doesn't exist.
 */
export function saveConfig(config: BridgeConfig): string {
  const configPath = findConfigPath() ?? CONFIG_PATHS[0];
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return configPath;
}
