/**
 * A Taskwarrior task as JSON. Includes standard fields plus UDAs.
 * See: https://taskwarrior.org/docs/design/task.html
 */
export interface TWTask {
  uuid: string;
  description: string;
  status: 'pending' | 'completed' | 'deleted' | 'waiting' | 'recurring';
  entry: string;
  modified?: string;
  start?: string;
  end?: string;
  project?: string;
  tags?: string[];
  priority?: 'H' | 'M' | 'L';
  annotations?: Array<{ entry: string; description: string }>;

  // UDAs added by tw-bridge
  backend?: string;
  backend_id?: string;

  [key: string]: unknown;
}

export interface AdapterConfig {
  [key: string]: unknown;
}

export interface BackendConfig {
  adapter: string;
  match: MatchRule;
  /** Statuses that mean "done" — tasks with these tags get completed in TW. Defaults to ["done"] */
  done_statuses?: string[];
  config?: AdapterConfig;
}

export interface MatchRule {
  /** Match tasks with any of these tags */
  tags?: string[];
  /** Match tasks with this project */
  project?: string;
}

export interface BridgeConfig {
  /** Context to use when cwd doesn't match any backend. Omit for no context. */
  default_context?: string;
  backends: Record<string, BackendConfig>;
}
