import type { TWTask, AdapterConfig } from './types.js';

/**
 * Adapter interface for task management backends.
 *
 * Adapters bridge Taskwarrior lifecycle events to external systems.
 * All lifecycle methods are optional — implement only what the backend supports.
 */
export interface Adapter {
  readonly name: string;

  /** Initialize the adapter with backend-specific config */
  init(config: AdapterConfig): Promise<void>;

  /**
   * Return the default config for this adapter given the setup context.
   * Called during `tw-bridge add` to generate the config entry.
   * `cwd` is the user's current directory (may or may not be relevant).
   */
  defaultConfig(cwd: string): AdapterConfig;

  /** Pull tasks from the backend into Taskwarrior */
  pull(): Promise<TWTask[]>;

  /**
   * Called when a task is started in Taskwarrior (`task start`).
   * ttyFd is a file descriptor to /dev/tty for interactive I/O.
   */
  onStart?(task: TWTask, ttyFd: number): Promise<void>;

  /** Called when a task is stopped (`task stop`) */
  onStop?(task: TWTask): Promise<void>;

  /** Called when a task is completed (`task done`) */
  onDone?(task: TWTask): Promise<void>;

  /** Called on any modification not covered above */
  onModify?(oldTask: TWTask, newTask: TWTask): Promise<void>;
}
