import type { Adapter } from './adapter.js';
import type { TWTask, BackendConfig, BridgeConfig } from './types.js';
import { GhpAdapter } from './adapters/ghp.js';
import { AsanaAdapter } from './adapters/asana.js';
import { StretyAdapter } from './adapters/strety.js';

const BUILTIN_ADAPTERS: Record<string, () => Adapter> = {
  ghp: () => new GhpAdapter(),
  asana: () => new AsanaAdapter(),
  strety: () => new StretyAdapter(),
};

/**
 * Find the matching backend config for a task based on its tags/project.
 */
export function matchBackend(
  task: TWTask,
  config: BridgeConfig,
): { name: string; backend: BackendConfig } | null {
  // First check the backend UDA (explicit assignment)
  if (task.backend && config.backends[task.backend]) {
    return { name: task.backend, backend: config.backends[task.backend] };
  }

  // Fall back to matching rules
  for (const [name, backend] of Object.entries(config.backends)) {
    const { match } = backend;

    if (match.tags?.length && task.tags?.some((t) => match.tags!.includes(t))) {
      return { name, backend };
    }

    if (match.project && task.project === match.project) {
      return { name, backend };
    }
  }

  return null;
}

/**
 * Create an adapter instance by type name (for setup/add commands).
 */
export function createAdapter(adapterType: string): Adapter | null {
  const factory = BUILTIN_ADAPTERS[adapterType];
  if (!factory) return null;
  return factory();
}

export function listAdapterTypes(): string[] {
  return Object.keys(BUILTIN_ADAPTERS);
}

/**
 * Resolve and initialize an adapter for a task.
 */
export async function resolveAdapter(
  task: TWTask,
  config: BridgeConfig,
): Promise<Adapter | null> {
  const matched = matchBackend(task, config);
  if (!matched) return null;

  const factory = BUILTIN_ADAPTERS[matched.backend.adapter];
  if (!factory) {
    process.stderr.write(`tw-bridge: unknown adapter "${matched.backend.adapter}"\n`);
    return null;
  }

  const adapter = factory();
  await adapter.init(matched.backend.config ?? {});
  return adapter;
}
