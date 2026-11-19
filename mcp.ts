// The MCP endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP. It speaks the modern
// server/discover revision (2026-07-28) and the legacy initialize handshake, and its tools
// act on the same store as REST, so an issue created here reads back over /api/v3 as the
// same object. Plain JSON answers (no SSE) are the transport's simple form.

import type { RepoRec, Store } from './store.ts';
import { issueJson, mergePullRecord, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The full name, owner/repo.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    properties: {},
    required: [],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by its number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'number', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const TOOLS = TOOL_DEFS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: {
    type: 'object',
    properties: tool.properties,
    required: tool.required,
    additionalProperties: true,
  },
}));

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argsOf(params: Record<string, unknown>): Record<string, unknown> {
  const args = params.arguments;
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
}

function repoArg(store: Store, args: Record<string, unknown>): RepoRec | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const [o, r] = args.full_name.split('/');
    if (o !== undefined && r !== undefined) {
      owner = owner === '' ? o : owner;
      repo = repo === '' ? r : repo;
    }
  }
  if (owner === '' || repo === '') return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(store: Store, name: string, params: Record<string, unknown>): ToolResult {
  const def = TOOL_DEFS.find((tool) => tool.name === name);
  if (def === undefined) throw new RpcError(-32602, `unknown tool ${name}`);
  const args = argsOf(params);
  for (const required of def.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      // get_repo may be addressed by full_name alone.
      if (name === 'get_repo' && typeof args.full_name === 'string' && args.full_name.includes('/')) continue;
      throw new RpcError(-32602, `missing required argument ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = store.getRepo(store.viewer.login, repoName);
      if (existing !== undefined) return okResult(repoJson(store, existing));
      const repo = store.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      if (repo === null) return errorResult(`repository ${repoName} already exists`);
      return okResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = repoArg(store, args);
      if (repo === null) return errorResult('repository not found');
      return okResult(repoJson(store, repo));
    }
    case 'list_repos': {
      return okResult(store.viewerRepos().map((repo) => repoJson(store, repo)));
    }
    case 'create_issue': {
      const repo = repoArg(store, args);
      if (repo === null) return errorResult('repository not found');
      const stamp = store.nowIso();
      const issue = {
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
        tick: repo.nextNumber,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return okResult(issueJson(store, repo, issue));
    }
    case 'get_issue': {
      const repo = repoArg(store, args);
      if (repo === null) return errorResult('repository not found');
      const number = Number(args.issue_number ?? args.number);
      const issue = repo.issues.get(number);
      if (issue === undefined) return errorResult(`issue ${number} not found`);
      return okResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const repo = repoArg(store, args);
      if (repo === null) return errorResult('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      return okResult(issues.map((issue) => issueJson(store, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoArg(store, args);
      if (repo === null) return errorResult('repository not found');
      const stripOwner = (ref: string): string => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);
      const head = stripOwner(String(args.head));
      const base = stripOwner(String(args.base));
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        return errorResult('head or base branch does not exist');
      }
      const stamp = store.nowIso();
      const pull = {
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
        tick: repo.nextNumber,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return okResult(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoArg(store, args);
      if (repo === null) return errorResult('repository not found');
      const number = Number(args.pull_number ?? args.pullNumber ?? args.number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return errorResult(`pull request ${number} not found`);
      const result = mergePullRecord(store, repo, pull, 'squash');
      if ('error' in result) return errorResult(result.message);
      return okResult(pullJson(store, repo, pull));
    }
    default:
      throw new RpcError(-32602, `unknown tool ${name}`);
  }
}

function processMessage(store: Store, message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params =
    typeof message.params === 'object' && message.params !== null
      ? (message.params as Record<string, unknown>)
      : {};
  if (id === undefined) return null; // a notification: nothing to answer
  try {
    let result: unknown;
    switch (method) {
      case 'server/discover':
        result = {
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          serverInfo: SERVER_INFO,
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          protocolVersion: '2026-07-28',
        };
        break;
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        result = {
          protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        };
        break;
      }
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        result = callTool(store, name, params);
        break;
      }
      case 'resources/list':
        result = { resources: [] };
        break;
      case 'prompts/list':
        result = { prompts: [] };
        break;
      default:
        throw new RpcError(-32601, `method not found: ${method}`);
    }
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    if (err instanceof RpcError) {
      return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message } };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : 'internal error' },
    };
  }
}

/** POST /mcp. A body that is not JSON answers HTTP 400 with a -32700 parse error. */
export function handleMcp(store: Store, bodyText: string): { status: number; body?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const item of parsed) {
      if (typeof item === 'object' && item !== null) {
        const reply = processMessage(store, item as Record<string, unknown>);
        if (reply !== null) replies.push(reply);
      }
    }
    return replies.length > 0 ? { status: 200, body: replies } : { status: 202 };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const reply = processMessage(store, parsed as Record<string, unknown>);
  return reply === null ? { status: 202 } : { status: 200, body: reply };
}
