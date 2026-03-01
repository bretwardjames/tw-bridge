import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Adapter } from '../adapter.js';
import type { TWTask, AdapterConfig } from '../types.js';

// --- Asana API client ---

const API_BASE = 'https://app.asana.com/api/1.0';
const OAUTH_AUTHORIZE = 'https://app.asana.com/-/oauth_authorize';
const OAUTH_TOKEN = 'https://app.asana.com/-/oauth_token';
const OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';
const TOKEN_FILE = path.join(os.homedir(), '.config', 'tw-bridge', 'asana-tokens.json');

interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  client_id: string;
  client_secret: string;
}

function loadTokens(): OAuthTokens | null {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens: OAuthTokens) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function refreshAccessToken(tokens: OAuthTokens): Promise<string> {
  const now = Date.now();
  // Refresh if within 5 minutes of expiry
  if (tokens.access_token && tokens.expires_at > now + 300_000) {
    return tokens.access_token;
  }

  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: tokens.client_id,
      client_secret: tokens.client_secret,
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  tokens.access_token = data.access_token;
  tokens.expires_at = now + (data.expires_in ?? 3600) * 1000;
  saveTokens(tokens);
  return tokens.access_token;
}

async function oauthLogin(
  clientId: string,
  clientSecret: string,
  rl: ReturnType<typeof createInterface>,
): Promise<OAuthTokens> {
  const authUrl =
    `${OAUTH_AUTHORIZE}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(OOB_REDIRECT)}&response_type=code`;

  console.log(`\n  Opening browser for authorization...`);
  console.log(`  If it doesn't open, visit:\n  ${authUrl}\n`);

  try {
    execSync(`xdg-open "${authUrl}" 2>/dev/null || open "${authUrl}" 2>/dev/null`, {
      stdio: 'ignore',
    });
  } catch {
    // Browser open failed — URL is printed above
  }

  const code = (await rl.question('  Paste the authorization code: ')).trim();
  if (!code) throw new Error('No authorization code provided');

  const tokenRes = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: OOB_REDIRECT,
      code,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${body}`);
  }

  const data = await tokenRes.json();
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    client_id: clientId,
    client_secret: clientSecret,
  };

  saveTokens(tokens);
  return tokens;
}

// --- API helpers ---

async function asanaFetch(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<any> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Asana API ${res.status}: ${body}`);
  }

  const json = await res.json();
  return json.data;
}

async function asanaFetchAll(
  path: string,
  token: string,
): Promise<any[]> {
  const results: any[] = [];
  let nextPage: string | null = path;

  while (nextPage) {
    const url = `${API_BASE}${nextPage}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Asana API ${res.status}: ${body}`);
    }

    const json = await res.json();
    results.push(...json.data);

    if (json.next_page?.path) {
      nextPage = json.next_page.path;
    } else {
      nextPage = null;
    }
  }

  return results;
}

// --- Interactive helpers ---

async function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> {
  return rl.question(question);
}

async function pickOne(
  rl: ReturnType<typeof createInterface>,
  label: string,
  items: Array<{ gid: string; name: string }>,
): Promise<{ gid: string; name: string }> {
  console.log(`\n${label}:`);
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${i + 1}) ${items[i].name}`);
  }

  while (true) {
    const answer = await prompt(rl, `Choose (1-${items.length}): `);
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < items.length) return items[idx];
    console.log('  Invalid choice, try again.');
  }
}

// --- Types ---

interface SectionMapping {
  gid: string;
  name: string;
  tag: string;
}

export interface AsanaAdapterConfig extends AdapterConfig {
  /** "oauth", "env:VAR_NAME", or a raw PAT */
  auth: string;
  workspace_gid: string;
  project_gid: string;
  project_name: string;
  sections: SectionMapping[];
  done_sections: string[];
  start_section_gid?: string;
}

interface AsanaTask {
  gid: string;
  name: string;
  completed: boolean;
  completed_at: string | null;
  assignee: { gid: string; name: string } | null;
  memberships: Array<{
    project: { gid: string; name: string };
    section: { gid: string; name: string };
  }>;
  permalink_url: string;
  custom_fields?: Array<{
    gid: string;
    name: string;
    display_value: string | null;
  }>;
}

// --- Adapter ---

export class AsanaAdapter implements Adapter {
  readonly name = 'asana';
  private config!: AsanaAdapterConfig;
  private accessToken: string | null = null;

  /**
   * Resolve the access token based on auth config.
   * - "oauth": load from token file, refresh if needed
   * - "env:VAR": read from environment
   * - anything else: treat as raw PAT
   */
  private async resolveToken(): Promise<string> {
    const auth = this.config.auth;

    if (auth === 'oauth') {
      // Always delegate to refreshAccessToken so expiry is re-checked
      const tokens = loadTokens();
      if (!tokens) throw new Error('No OAuth tokens found. Run `tw-bridge add` to authenticate.');
      this.accessToken = await refreshAccessToken(tokens);
      return this.accessToken;
    }

    if (this.accessToken) return this.accessToken;

    if (auth.startsWith('env:')) {
      const envVar = auth.slice(4);
      const val = process.env[envVar];
      if (!val) throw new Error(`Environment variable ${envVar} not set`);
      this.accessToken = val;
      return val;
    }

    // Raw PAT
    this.accessToken = auth;
    return auth;
  }

  defaultConfig(_cwd: string): AdapterConfig {
    return {
      auth: 'env:ASANA_TOKEN',
      workspace_gid: '',
      project_gid: '',
      project_name: '',
      sections: [],
      done_sections: [],
    };
  }

  async setup(_cwd: string): Promise<AdapterConfig> {
    const rl = createInterface({ input: stdin, output: stdout });

    try {
      console.log('\n── Asana Adapter Setup ──\n');

      // Step 1: Authentication
      console.log('Authentication:');
      console.log('  1) OAuth (browser login)');
      console.log('  2) Personal Access Token');
      console.log('  3) Environment variable');

      const authChoice = await prompt(rl, '\nChoose (1-3): ');
      let authConfig: string;
      let token: string;

      if (authChoice.trim() === '1') {
        // OAuth OOB flow
        const clientId = (await prompt(rl, '\nAsana App Client ID: ')).trim();
        const clientSecret = (await prompt(rl, 'Asana App Client Secret: ')).trim();

        if (!clientId || !clientSecret) {
          console.error('\n  Client ID and Secret are required.');
          console.error('  Create an app at: https://app.asana.com/0/my-apps');
          console.error('  Check "This is a native or command-line app"');
          rl.close();
          process.exit(1);
        }

        const tokens = await oauthLogin(clientId, clientSecret, rl);
        token = tokens.access_token;
        authConfig = 'oauth';
      } else if (authChoice.trim() === '3') {
        const envVar = await prompt(rl, 'Environment variable name [ASANA_TOKEN]: ');
        const varName = envVar.trim() || 'ASANA_TOKEN';
        authConfig = `env:${varName}`;
        token = process.env[varName] ?? '';
        if (!token) {
          console.log(`\n  Warning: ${varName} is not currently set.`);
          const tempToken = await prompt(rl, '  Paste a temporary token for setup (or Enter to skip): ');
          token = tempToken.trim();
          if (!token) {
            console.error(`\n  Cannot complete setup without a valid token.`);
            console.error(`  Set ${varName} in your environment and try again.`);
            rl.close();
            process.exit(1);
          }
        }
      } else {
        token = (await prompt(rl, 'Paste your Personal Access Token: ')).trim();
        authConfig = token;
      }

      // Verify
      console.log('\nVerifying...');
      let me: any;
      try {
        me = await asanaFetch('/users/me', token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Authentication failed: ${msg}`);
        rl.close();
        process.exit(1);
      }
      console.log(`  Authenticated as: ${me.name} (${me.email})`);

      // Step 2: Pick workspace
      const workspaces = await asanaFetch('/workspaces', token);
      let workspace: { gid: string; name: string };
      if (workspaces.length === 1) {
        workspace = workspaces[0];
        console.log(`\nWorkspace: ${workspace.name}`);
      } else {
        workspace = await pickOne(rl, 'Select workspace', workspaces);
      }

      // Step 3: Pick project
      const projects = await asanaFetchAll(
        `/workspaces/${workspace.gid}/projects?limit=100&archived=false`,
        token,
      );

      if (projects.length === 0) {
        console.error('\n  No projects found in this workspace.');
        rl.close();
        process.exit(1);
      }

      const project = await pickOne(rl, 'Select project', projects);

      // Step 4: Map sections
      const sections = await asanaFetch(
        `/projects/${project.gid}/sections`,
        token,
      );

      console.log(`\nSections in "${project.name}":`);
      console.log('Map each section to a Taskwarrior tag (or press Enter for default).\n');

      const sectionMappings: SectionMapping[] = [];
      const doneSections: string[] = [];

      for (const section of sections) {
        const defaultTag = section.name.toLowerCase().replace(/\s+/g, '_');
        const tag = await prompt(rl, `  "${section.name}" → tag [${defaultTag}]: `);
        const finalTag = tag.trim() || defaultTag;

        sectionMappings.push({
          gid: section.gid,
          name: section.name,
          tag: finalTag,
        });
      }

      // Step 5: Which sections mean "done"?
      console.log('\nWhich sections represent completed tasks?');
      for (let i = 0; i < sectionMappings.length; i++) {
        console.log(`  ${i + 1}) ${sectionMappings[i].name} (${sectionMappings[i].tag})`);
      }
      const doneAnswer = await prompt(rl, 'Enter numbers separated by commas (e.g., 4,5): ');
      for (const num of doneAnswer.split(',')) {
        const idx = parseInt(num.trim(), 10) - 1;
        if (idx >= 0 && idx < sectionMappings.length) {
          doneSections.push(sectionMappings[idx].gid);
        }
      }

      // Step 6: Which section for "task start"?
      console.log('\nWhich section should tasks move to on `task start`?');
      for (let i = 0; i < sectionMappings.length; i++) {
        console.log(`  ${i + 1}) ${sectionMappings[i].name}`);
      }
      console.log(`  0) Don't move (no action on start)`);
      const startAnswer = await prompt(rl, 'Choose: ');
      const startIdx = parseInt(startAnswer.trim(), 10) - 1;
      const startSectionGid =
        startIdx >= 0 && startIdx < sectionMappings.length
          ? sectionMappings[startIdx].gid
          : undefined;

      rl.close();

      console.log(`\n  Project: ${project.name}`);
      console.log(`  Sections: ${sectionMappings.map((s) => s.tag).join(', ')}`);
      console.log(`  Done: ${doneSections.length} section(s)`);
      if (startSectionGid) {
        const startSection = sectionMappings.find((s) => s.gid === startSectionGid);
        console.log(`  On start: move to "${startSection?.name}"`);
      }

      return {
        auth: authConfig,
        workspace_gid: workspace.gid,
        project_gid: project.gid,
        project_name: project.name,
        sections: sectionMappings,
        done_sections: doneSections,
        start_section_gid: startSectionGid,
      };
    } catch (err) {
      rl.close();
      throw err;
    }
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = config as AsanaAdapterConfig;
    if (!this.config.project_gid) {
      throw new Error('asana adapter requires "project_gid" in config');
    }
  }

  async pull(): Promise<TWTask[]> {
    const token = await this.resolveToken();
    const fields = [
      'gid',
      'name',
      'completed',
      'completed_at',
      'assignee',
      'assignee.name',
      'memberships.project',
      'memberships.project.name',
      'memberships.section',
      'memberships.section.name',
      'permalink_url',
      'custom_fields',
      'custom_fields.name',
      'custom_fields.display_value',
    ].join(',');

    const asanaTasks: AsanaTask[] = await asanaFetchAll(
      `/projects/${this.config.project_gid}/tasks?opt_fields=${fields}&limit=100`,
      token,
    );

    const tasks: TWTask[] = [];
    const sectionMap = new Map(
      this.config.sections.map((s) => [s.gid, s]),
    );

    for (const at of asanaTasks) {
      // Skip tasks marked complete via Asana's checkbox
      if (at.completed) continue;

      const membership = at.memberships?.find(
        (m) => m.project.gid === this.config.project_gid,
      );
      const sectionGid = membership?.section?.gid;
      const sectionMapping = sectionGid ? sectionMap.get(sectionGid) : null;

      const tags: string[] = [];
      if (sectionMapping) tags.push(sectionMapping.tag);

      const priority = mapAsanaPriority(at.custom_fields);

      const task: TWTask = {
        uuid: '',
        description: at.name,
        status: 'pending',
        entry: new Date().toISOString(),
        project: this.config.project_name,
        tags,
        priority,
        backend: '',
        backend_id: at.gid,
        annotations: at.permalink_url
          ? [{ entry: new Date().toISOString(), description: at.permalink_url }]
          : undefined,
      };

      tasks.push(task);
    }

    return tasks;
  }

  async onStart(task: TWTask, _ttyFd: number): Promise<void> {
    if (!this.config.start_section_gid) return;

    const taskGid = task.backend_id;
    if (!taskGid) return;

    const token = await this.resolveToken();
    const startSection = this.config.sections.find(
      (s) => s.gid === this.config.start_section_gid,
    );
    process.stderr.write(
      `tw-bridge [asana]: moving task to "${startSection?.name ?? 'In Progress'}"\n`,
    );

    await asanaFetch(`/sections/${this.config.start_section_gid}/addTask`, token, {
      method: 'POST',
      body: JSON.stringify({ data: { task: taskGid } }),
    });
  }

  async onDone(task: TWTask): Promise<void> {
    const taskGid = task.backend_id;
    if (!taskGid) return;

    const token = await this.resolveToken();
    process.stderr.write(`tw-bridge [asana]: marking task complete\n`);

    await asanaFetch(`/tasks/${taskGid}`, token, {
      method: 'PUT',
      body: JSON.stringify({ data: { completed: true } }),
    });
  }
}

function mapAsanaPriority(
  fields?: Array<{ name: string; display_value: string | null }>,
): 'H' | 'M' | 'L' | undefined {
  if (!fields) return undefined;
  const pField = fields.find(
    (f) => f.name.toLowerCase() === 'priority' && f.display_value,
  );
  if (!pField?.display_value) return undefined;

  const val = pField.display_value.toLowerCase();
  if (val.startsWith('high') || val === 'urgent' || val === 'p0' || val === 'p1') return 'H';
  if (val.startsWith('med') || val === 'p2') return 'M';
  if (val.startsWith('low') || val === 'p3' || val === 'p4') return 'L';
  return undefined;
}
