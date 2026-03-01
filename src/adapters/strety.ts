import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Adapter } from '../adapter.js';
import type { TWTask, AdapterConfig } from '../types.js';

// --- Strety API constants ---

const API_BASE = 'https://2.strety.com/api/v1';
const OAUTH_AUTHORIZE = `${API_BASE}/oauth/authorize`;
const OAUTH_TOKEN = `${API_BASE}/oauth/token`;
const TOKEN_FILE = path.join(os.homedir(), '.config', 'tw-bridge', 'strety-tokens.json');

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
  if (tokens.access_token && tokens.expires_at > now + 300_000) {
    return tokens.access_token;
  }

  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: tokens.client_id,
      client_secret: tokens.client_secret,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  tokens.access_token = data.access_token;
  // Strety rotates refresh tokens on each use
  if (data.refresh_token) {
    tokens.refresh_token = data.refresh_token;
  }
  tokens.expires_at = now + (data.expires_in ?? 7200) * 1000;
  saveTokens(tokens);
  return tokens.access_token;
}

// --- OAuth manual-paste flow ---
// Strety requires HTTPS redirect URIs, so we can't use a localhost HTTP server.
// Instead: open the auth URL, user authorizes, browser redirects to a dead URL,
// user copies the URL from the address bar and pastes it here.

const REDIRECT_URI = 'https://localhost/callback';

async function oauthLogin(
  clientId: string,
  clientSecret: string,
  rl: ReturnType<typeof createInterface>,
): Promise<OAuthTokens> {
  const authUrl =
    `${OAUTH_AUTHORIZE}?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent('read write')}`;

  console.log(`\n  Opening browser for authorization...`);
  console.log(`  If it doesn't open, visit:\n  ${authUrl}\n`);

  try {
    execSync(`xdg-open "${authUrl}" 2>/dev/null || open "${authUrl}" 2>/dev/null`, {
      stdio: 'ignore',
    });
  } catch {
    // Browser open failed — URL is printed above
  }

  console.log('  After authorizing, the browser will redirect to a page that');
  console.log('  won\'t load. Copy the full URL from the address bar and paste it here.\n');

  const pasted = (await rl.question('Paste the callback URL: ')).trim();

  // Extract the authorization code from the pasted URL
  let code: string;
  try {
    const url = new URL(pasted);
    const error = url.searchParams.get('error');
    if (error) {
      throw new Error(`OAuth error: ${error}`);
    }
    const authCode = url.searchParams.get('code');
    if (!authCode) {
      throw new Error('No authorization code found in URL');
    }
    code = authCode;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('OAuth error:')) throw err;
    if (err instanceof Error && err.message.startsWith('No authorization')) throw err;
    throw new Error(`Could not parse callback URL: ${pasted}`);
  }

  // Exchange code for tokens
  const tokenRes = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      client_secret: clientSecret,
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
    expires_at: Date.now() + (data.expires_in ?? 7200) * 1000,
    client_id: clientId,
    client_secret: clientSecret,
  };

  saveTokens(tokens);
  return tokens;
}

// --- JSON:API client ---

async function stretyFetch(
  urlOrPath: string,
  token: string,
  options: RequestInit = {},
): Promise<any> {
  const url = urlOrPath.startsWith('http') ? urlOrPath : `${API_BASE}${urlOrPath}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Strety API ${res.status}: ${body}`);
  }

  return res.json();
}

async function stretyFetchAll(
  path: string,
  token: string,
): Promise<any[]> {
  const results: any[] = [];
  let url: string | null = `${API_BASE}${path}`;

  while (url) {
    const json = await stretyFetch(url, token);
    results.push(...json.data);
    url = json.links?.next ?? null;
  }

  return results;
}

// --- Interactive helpers ---

async function pickOne(
  rl: ReturnType<typeof createInterface>,
  label: string,
  items: Array<{ id: string; attributes: { name?: string; title?: string } }>,
): Promise<{ id: string; name: string }> {
  console.log(`\n${label}:`);
  for (let i = 0; i < items.length; i++) {
    const name = items[i].attributes.name ?? items[i].attributes.title ?? items[i].id;
    console.log(`  ${i + 1}) ${name}`);
  }

  while (true) {
    const answer = await rl.question(`Choose (1-${items.length}): `);
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < items.length) {
      const item = items[idx];
      return { id: item.id, name: item.attributes.name ?? item.attributes.title ?? item.id };
    }
    console.log('  Invalid choice, try again.');
  }
}

// --- Types ---

export interface StretyAdapterConfig extends AdapterConfig {
  /** "oauth" or "env:VAR_NAME" */
  auth: string;
  /** Filter todos by this person's UUID */
  assignee_id: string;
  assignee_name: string;
}

// --- Adapter ---

export class StretyAdapter implements Adapter {
  readonly name = 'strety';
  private config!: StretyAdapterConfig;
  private accessToken: string | null = null;

  private async resolveToken(): Promise<string> {
    const auth = this.config.auth;

    if (auth === 'oauth') {
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

    this.accessToken = auth;
    return auth;
  }

  defaultConfig(_cwd: string): AdapterConfig {
    return {
      auth: 'env:STRETY_TOKEN',
      assignee_id: '',
      assignee_name: '',
    };
  }

  async setup(_cwd: string): Promise<AdapterConfig> {
    const rl = createInterface({ input: stdin, output: stdout });

    try {
      console.log('\n── Strety Adapter Setup ──\n');

      // Step 1: Authentication
      console.log('Authentication:');
      console.log('  1) OAuth (browser login)');
      console.log('  2) Environment variable');

      const authChoice = (await rl.question('\nChoose (1-2): ')).trim();
      let authConfig: string;
      let token: string;

      if (authChoice === '1') {
        console.log(`\n  Register a Strety app at My Integrations > My Apps.`);
        console.log(`  Set the Redirect URI to: ${REDIRECT_URI}\n`);

        const clientId = (await rl.question('Strety App Client ID: ')).trim();
        const clientSecret = (await rl.question('Strety App Client Secret: ')).trim();

        if (!clientId || !clientSecret) {
          console.error('\n  Client ID and Secret are required.');
          rl.close();
          process.exit(1);
        }

        const tokens = await oauthLogin(clientId, clientSecret, rl);
        token = tokens.access_token;
        authConfig = 'oauth';
      } else {
        const envVar = await rl.question('Environment variable name [STRETY_TOKEN]: ');
        const varName = envVar.trim() || 'STRETY_TOKEN';
        authConfig = `env:${varName}`;
        token = process.env[varName] ?? '';
        if (!token) {
          console.error(`\n  Cannot complete setup without a valid token.`);
          console.error(`  Set ${varName} in your environment and try again.`);
          rl.close();
          process.exit(1);
        }
      }

      // Step 2: Verify + pick yourself from people list
      console.log('\nVerifying...');
      let people: any[];
      try {
        people = await stretyFetchAll('/people?page[size]=20', token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Authentication failed: ${msg}`);
        rl.close();
        process.exit(1);
      }

      console.log(`  Connected! Found ${people.length} people.`);

      const person = await pickOne(rl, 'Which person are you? (for filtering your todos)', people);

      rl.close();

      console.log(`\n  Assignee: ${person.name}`);
      console.log('  Syncing: Todos assigned to you');

      return {
        auth: authConfig,
        assignee_id: person.id,
        assignee_name: person.name,
      };
    } catch (err) {
      rl.close();
      throw err;
    }
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = config as StretyAdapterConfig;
    if (!this.config.assignee_id) {
      throw new Error('strety adapter requires "assignee_id" in config');
    }
  }

  async pull(): Promise<TWTask[]> {
    const token = await this.resolveToken();
    const raw = await stretyFetchAll(
      `/todos?filter[assignee_id]=${this.config.assignee_id}&page[size]=20`,
      token,
    );

    const tasks: TWTask[] = [];

    for (const item of raw) {
      const attrs = item.attributes;

      // Skip completed todos
      if (attrs.completed_at) continue;

      const priority = mapStretyPriority(attrs.priority);

      const task: TWTask = {
        uuid: '',
        description: attrs.title,
        status: 'pending',
        entry: attrs.created_at ?? new Date().toISOString(),
        tags: [],
        priority,
        backend: '',
        backend_id: item.id,
        ...(attrs.due_date && { due: new Date(attrs.due_date).toISOString() }),
      };

      tasks.push(task);
    }

    return tasks;
  }

  async onDone(task: TWTask): Promise<void> {
    const todoId = task.backend_id;
    if (!todoId) return;

    const token = await this.resolveToken();
    process.stderr.write(`tw-bridge [strety]: marking todo complete\n`);

    await stretyFetch(`/todos/${todoId}`, token, {
      method: 'PATCH',
      headers: { 'If-Match': '*' },
      body: JSON.stringify({
        data: {
          type: 'todo',
          attributes: {
            completed_at: new Date().toISOString(),
          },
        },
      }),
    });
  }
}

function mapStretyPriority(
  priority?: string | null,
): 'H' | 'M' | 'L' | undefined {
  if (!priority || priority === 'none') return undefined;
  if (priority === 'highest' || priority === 'high') return 'H';
  if (priority === 'medium') return 'M';
  if (priority === 'low' || priority === 'lowest') return 'L';
  return undefined;
}
