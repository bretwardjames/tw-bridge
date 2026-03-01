import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, findConfigPath, saveConfig } from './config.js';
import { resolveAdapter, createAdapter, listAdapterTypes } from './registry.js';
import {
  getExistingTasks,
  importTask,
  updateTaskTags,
  updateTaskDescription,
  completeTask,
  ensureContext,
} from './taskwarrior.js';

const HOOKS_DIR = path.join(os.homedir(), '.task', 'hooks');

const commands: Record<string, () => Promise<void>> = {
  add: addBackend,
  install,
  sync,
  timewarrior: timewarriorCmd,
  which,
  config: showConfig,
};

async function main() {
  const command = process.argv[2];

  if (!command || command === '--help') {
    console.log('Usage: tw-bridge <command>\n');
    console.log('Commands:');
    console.log('  add       Add a new backend instance');
    console.log('  install   Install Taskwarrior hooks and shell integration');
    console.log('  sync        Pull tasks from all backends');
    console.log('  timewarrior Manage Timewarrior integration');
    console.log('  which       Print the context for the current directory');
    console.log('  config      Show current configuration');
    return;
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }

  await handler();
}

function parseFlag(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function addBackend() {
  const name = process.argv[3];
  const adapterType = parseFlag('--adapter');
  const tagOverride = parseFlag('--tag');

  if (!name || name.startsWith('--')) {
    console.error('Usage: tw-bridge add <name> --adapter <type> [--tag <context-tag>]');
    console.error(`\nAvailable adapters: ${listAdapterTypes().join(', ')}`);
    process.exit(1);
  }

  if (!adapterType) {
    console.error('Missing --adapter flag.');
    console.error(`Available adapters: ${listAdapterTypes().join(', ')}`);
    process.exit(1);
  }

  const adapter = createAdapter(adapterType);
  if (!adapter) {
    console.error(`Unknown adapter: ${adapterType}`);
    console.error(`Available adapters: ${listAdapterTypes().join(', ')}`);
    process.exit(1);
  }

  const config = loadConfig();

  if (config.backends[name]) {
    console.error(`Backend "${name}" already exists. Remove it first or choose a different name.`);
    process.exit(1);
  }

  const matchTag = tagOverride ?? name;
  const cwd = process.cwd();

  // Use interactive setup if the adapter provides it, otherwise default config
  const adapterConfig = adapter.setup
    ? await adapter.setup(cwd)
    : adapter.defaultConfig(cwd);

  // Derive done_statuses from adapter config (e.g., Asana section mappings)
  let doneStatuses: string[] | undefined;
  const sections = adapterConfig.sections as Array<{ gid: string; tag: string }> | undefined;
  const doneSectionGids = adapterConfig.done_sections as string[] | undefined;
  if (sections?.length && doneSectionGids?.length) {
    const gidSet = new Set(doneSectionGids);
    doneStatuses = sections
      .filter((s) => gidSet.has(s.gid))
      .map((s) => s.tag);
  }

  config.backends[name] = {
    adapter: adapterType,
    match: { tags: [matchTag] },
    ...(doneStatuses?.length && { done_statuses: doneStatuses }),
    config: adapterConfig,
  };

  const configPath = saveConfig(config);
  console.log(`\nAdded backend "${name}" (adapter: ${adapterType})`);
  console.log(`Config: ${configPath}`);
  console.log(`Match tag: +${matchTag}`);

  if (adapterConfig.cwd) {
    console.log(`Working directory: ${adapterConfig.cwd}`);
  }
  if (adapterConfig.project) {
    console.log(`Project: ${adapterConfig.project}`);
  }

  // Run first sync immediately
  console.log('');
  await syncBackend(name, config.backends[name], config);

  console.log(`\nUse 'task context ${matchTag}' to switch to this project.`);
}

async function install() {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });

  const hookSource = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    'hooks',
    'on-modify.js',
  );
  const hookTarget = path.join(HOOKS_DIR, 'on-modify.tw-bridge');

  if (fs.existsSync(hookTarget)) {
    fs.unlinkSync(hookTarget);
  }

  fs.symlinkSync(hookSource, hookTarget);
  fs.chmodSync(hookSource, 0o755);

  console.log(`Installed hook: ${hookTarget} -> ${hookSource}`);

  // Remind about .taskrc configuration
  console.log('\nAdd these to your .taskrc:\n');
  console.log('# --- tw-bridge UDAs ---');
  console.log('uda.backend.type=string');
  console.log('uda.backend.label=Backend');
  console.log('uda.backend_id.type=string');
  console.log('uda.backend_id.label=Backend ID');
  console.log('');
  console.log('# --- Urgency coefficients (adjust to taste) ---');
  console.log('urgency.user.tag.backlog.coefficient=0.0');
  console.log('urgency.user.tag.todo.coefficient=1.0');
  console.log('urgency.user.tag.in_progress.coefficient=4.0');
  console.log('urgency.user.tag.in_review.coefficient=-2.0');
  console.log('urgency.user.tag.ready_for_beta.coefficient=-4.0');
  console.log('urgency.user.tag.in_beta.coefficient=-6.0');

  // Install Timewarrior extension
  installTimewExtension();

  // Timewarrior hint
  if (fs.existsSync(STANDARD_TIMEW_HOOK)) {
    console.log('\nTimewarrior hook detected. To enable tw-bridge time tracking:');
    console.log('  tw-bridge timewarrior enable');
  }

  // Install shell integration
  installShellFunction();
}

const TIMEW_EXT_DIR = path.join(os.homedir(), '.timewarrior', 'extensions');

function installTimewExtension() {
  fs.mkdirSync(TIMEW_EXT_DIR, { recursive: true });

  const extSource = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    'extensions',
    'bridge.js',
  );
  const extTarget = path.join(TIMEW_EXT_DIR, 'bridge');

  if (fs.existsSync(extTarget)) {
    fs.unlinkSync(extTarget);
  }

  fs.symlinkSync(extSource, extTarget);
  fs.chmodSync(extSource, 0o755);

  console.log(`\nInstalled Timewarrior extension: ${extTarget} -> ${extSource}`);
  console.log('  Usage: timew bridge [task-time|wall-time] [project-filter]');
}

const STANDARD_TIMEW_HOOK = path.join(HOOKS_DIR, 'on-modify.timewarrior');

async function timewarriorCmd() {
  const sub = process.argv[3];

  if (!sub || sub === '--help') {
    console.log('Usage: tw-bridge timewarrior <subcommand>\n');
    console.log('Subcommands:');
    console.log('  enable   Enable Timewarrior tracking');
    console.log('  disable  Disable Timewarrior tracking');
    console.log('  status   Show current Timewarrior configuration');
    console.log('\nParallel time tracking is controlled per-invocation:');
    console.log('  task start <id> --parallel   Track in parallel with current task');
    console.log('  task start <id> --switch     Stop current task, start new one');
    return;
  }

  const config = loadConfig();

  if (sub === 'status') {
    const tw = config.timewarrior;
    if (!tw?.enabled) {
      console.log('Timewarrior: disabled');
    } else {
      console.log('Timewarrior: enabled');
      console.log('  Parallel tracking: use `task start <id> --parallel`');
    }
    const hookExists = fs.existsSync(STANDARD_TIMEW_HOOK);
    const hookDisabled = fs.existsSync(STANDARD_TIMEW_HOOK + '.disabled');
    if (hookExists) {
      console.log(`Standard hook: active (${STANDARD_TIMEW_HOOK})`);
      if (tw?.enabled) {
        console.log('  Warning: may cause double-tracking. Run `tw-bridge timewarrior enable` to fix.');
      }
    } else if (hookDisabled) {
      console.log('Standard hook: disabled');
    } else {
      console.log('Standard hook: not found');
    }
    return;
  }

  if (sub === 'enable') {
    config.timewarrior = { enabled: true };
    const configPath = saveConfig(config);
    console.log('Timewarrior tracking enabled');
    console.log(`Config: ${configPath}`);

    // Disable the standard hook to avoid double-tracking
    if (fs.existsSync(STANDARD_TIMEW_HOOK)) {
      const disabled = STANDARD_TIMEW_HOOK + '.disabled';
      fs.renameSync(STANDARD_TIMEW_HOOK, disabled);
      console.log(`\nDisabled standard hook: ${STANDARD_TIMEW_HOOK} -> .disabled`);
      console.log('tw-bridge will handle Timewarrior tracking directly.');
    }

    return;
  }

  if (sub === 'disable') {
    config.timewarrior = { enabled: false };
    const configPath = saveConfig(config);
    console.log('Timewarrior tracking disabled');
    console.log(`Config: ${configPath}`);

    // Re-enable the standard hook if it was disabled
    const disabled = STANDARD_TIMEW_HOOK + '.disabled';
    if (fs.existsSync(disabled)) {
      fs.renameSync(disabled, STANDARD_TIMEW_HOOK);
      console.log(`\nRestored standard hook: ${STANDARD_TIMEW_HOOK}`);
    }

    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  process.exit(1);
}

const SHELL_FUNCTION = `
# tw-bridge: auto-context task wrapper
task() {
  local ctx mode=""
  local args=()

  for arg in "$@"; do
    case "$arg" in
      --parallel|-p) mode="parallel" ;;
      --switch|-s)   mode="switch" ;;
      *)             args+=("$arg") ;;
    esac
  done

  ctx=$(tw-bridge which 2>/dev/null)
  TW_BRIDGE_MODE="$mode" command task \${ctx:+"rc.context=$ctx"} "\${args[@]}"
}
`.trim();

const SHELL_MARKER = '# tw-bridge: auto-context task wrapper';

function installShellFunction() {
  const shell = process.env.SHELL ?? '/bin/bash';
  const home = os.homedir();

  let rcFile: string;
  if (shell.endsWith('zsh')) {
    rcFile = path.join(home, '.zshrc');
  } else {
    rcFile = path.join(home, '.bashrc');
  }

  const existing = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf-8') : '';

  if (existing.includes(SHELL_MARKER)) {
    console.log(`\nShell integration already installed in ${rcFile}`);
    return;
  }

  fs.appendFileSync(rcFile, '\n' + SHELL_FUNCTION + '\n');
  console.log(`\nShell integration installed in ${rcFile}`);
  console.log('Restart your shell or run: source ' + rcFile);
}

const SEEN_FILE = path.join(os.homedir(), '.config', 'tw-bridge', '.seen-dirs');

function loadSeenDirs(): Set<string> {
  try {
    const raw = fs.readFileSync(SEEN_FILE, 'utf-8');
    return new Set(raw.split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

function markDirSeen(dir: string) {
  const seen = loadSeenDirs();
  if (seen.has(dir)) return;
  seen.add(dir);
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, [...seen].join('\n') + '\n');
}

function isGitRepo(dir: string): boolean {
  try {
    let current = dir;
    while (current !== path.dirname(current)) {
      if (fs.existsSync(path.join(current, '.git'))) return true;
      current = path.dirname(current);
    }
    return false;
  } catch {
    return false;
  }
}

async function which() {
  const cwd = process.cwd();
  const config = loadConfig();

  // Check each backend for a cwd match
  for (const [_name, backend] of Object.entries(config.backends)) {
    const backendCwd = (backend.config as any)?.cwd;
    if (!backendCwd) continue;

    const resolved = path.resolve(backendCwd);
    if (cwd === resolved || cwd.startsWith(resolved + path.sep)) {
      const contextTag = backend.match.tags?.[0];
      if (contextTag) {
        process.stdout.write(contextTag);
        return;
      }
    }
  }

  // No match — use default context if configured
  if (config.default_context) {
    process.stdout.write(config.default_context);
    return;
  }

  // If we're in a git repo that isn't configured, hint once
  if (isGitRepo(cwd)) {
    const seen = loadSeenDirs();
    // Find the git root for deduplication
    let gitRoot = cwd;
    let current = cwd;
    while (current !== path.dirname(current)) {
      if (fs.existsSync(path.join(current, '.git'))) {
        gitRoot = current;
        break;
      }
      current = path.dirname(current);
    }

    if (!seen.has(gitRoot)) {
      const dirName = path.basename(gitRoot);
      process.stderr.write(
        `tw-bridge: unconfigured project "${dirName}". Run: tw-bridge add ${dirName} --adapter ghp\n`,
      );
      markDirSeen(gitRoot);
    }
  }
}

async function sync() {
  const config = loadConfig();
  const backendNames = Object.keys(config.backends);

  if (backendNames.length === 0) {
    console.log('No backends configured. Use `tw-bridge add` to get started.');
    return;
  }

  for (const name of backendNames) {
    await syncBackend(name, config.backends[name], config);
  }
}

async function syncBackend(
  name: string,
  backend: import('./types.js').BackendConfig,
  config: import('./types.js').BridgeConfig,
) {
  const adapter = await resolveAdapter(
    { backend: name } as any,
    config,
  );

  if (!adapter) {
    console.error(`Skipping ${name}: adapter "${backend.adapter}" not found`);
    return;
  }

  console.log(`Syncing ${name}...`);

  // Ensure a task context exists for the match tag (shared across instances)
  const matchTags = backend.match.tags ?? [];
  if (matchTags.length > 0) {
    const contextName = matchTags[0];
    if (ensureContext(contextName, matchTags)) {
      console.log(`  Context "${contextName}" configured (${matchTags.map((t) => '+' + t).join(' ')})`);
    }
  }

  const remoteTasks = await adapter.pull();
  const existing = getExistingTasks(name);

  // Statuses that mean "completed" in Taskwarrior
  const doneStatuses = new Set(
    (backend.done_statuses ?? ['done']).map((s) => s.toLowerCase()),
  );

  // Stamp each task with the instance name and match tags
  for (const task of remoteTasks) {
    task.backend = name;
    task.tags = [...matchTags, ...(task.tags ?? [])];
  }

  let created = 0;
  let updated = 0;
  let completed = 0;
  let unchanged = 0;

  for (const task of remoteTasks) {
    const backendId = task.backend_id!;
    const existingTask = existing.get(backendId);

    // Check if this task's status is a "done" status
    const statusTag = task.tags?.find((t) => !matchTags.includes(t) && doneStatuses.has(t));
    const isDone = !!statusTag;

    if (!existingTask) {
      if (isDone) {
        // Don't import already-completed items
      } else {
        const { uuid } = importTask(task);
        console.log(`  + [#${backendId}] ${task.description} (${uuid.slice(0, 8)})`);
        created++;
      }
    } else if (isDone) {
      // Existing task moved to a done status — complete it
      if (completeTask(existingTask, matchTags)) {
        // Push completion back to the backend so it doesn't reappear
        if (adapter.onDone) {
          try {
            await adapter.onDone(task);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  ⚠ [#${backendId}] failed to push completion: ${msg}`);
          }
        }
        console.log(`  ✓ [#${backendId}] ${task.description}`);
        completed++;
      }
    } else {
      let changed = false;

      if (updateTaskDescription(existingTask, task.description)) {
        changed = true;
      }

      if (updateTaskTags(existingTask, task.tags ?? [])) {
        changed = true;
      }

      if (changed) {
        console.log(`  ~ [#${backendId}] ${task.description}`);
        updated++;
      } else {
        unchanged++;
      }
    }

    existing.delete(backendId);
  }

  if (existing.size > 0) {
    console.log(`  ${existing.size} task(s) no longer in ${name} (not modified)`);
  }

  console.log(`  Synced: ${created} created, ${updated} updated, ${completed} completed, ${unchanged} unchanged`);
}

async function showConfig() {
  const configPath = findConfigPath();
  if (!configPath) {
    console.log('No config file found. Searched:');
    console.log('  ~/.config/tw-bridge/config.json');
    console.log('  ~/.tw-bridge.json');
    return;
  }

  console.log(`Config: ${configPath}\n`);
  const config = loadConfig();
  console.log(JSON.stringify(config, null, 2));
}

main();
