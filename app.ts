// The forge's HTTP server: one process, four surfaces over a single in-memory store.
//
//   GET  /healthz                          the env's boot check (no auth)
//   *    /api/v3/...                       GitHub REST v3            (rest.ts)
//   POST /api/graphql                      GitHub GraphQL v4         (graphql.ts)
//   POST /mcp                              Model Context Protocol  (mcp.ts)
//   *    /<owner>/<repo>.git/...           git smart HTTP            (git.ts)
//
// Every surface but /healthz requires the trial's bearer token: when MAKEFUN_SHOP_TOKEN is
// set the Authorization header must carry exactly it; with no token configured (local
// development) any bearer token is accepted as the scenario viewer. A repository belongs to
// the token's login, so a name under another owner is 404, never 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './git.ts';

export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    handle(store, req, res).catch((err: unknown) => {
      process.stderr.write(`[forge] request failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ message: 'Internal Server Error' }));
    });
  });
  return server;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return header === `Bearer ${expected}`;
  return header.length > 'Bearer '.length;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(
  store: Store,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': store.requestId(),
    ...headers,
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://forge.local');
  const pathname = url.pathname;

  if (pathname === '/healthz' && method === 'GET') {
    sendJson(store, res, 200, { ok: true });
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? await readBody(req) : Buffer.alloc(0);
  const bodyText = body.toString('utf8');

  if (pathname === '/mcp') {
    if (!authorized(req)) {
      sendJson(store, res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(store, res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const reply = handleMcp(store, bodyText);
    if (reply.status === 202) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(store, res, reply.status, reply.body);
    return;
  }

  if (pathname === '/api/graphql' || pathname === '/api/graphql/') {
    if (!authorized(req)) {
      sendJson(store, res, 401, { message: 'Bad credentials' });
      return;
    }
    if (method !== 'POST') {
      sendJson(store, res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const reply = handleGraphql(store, bodyText);
    sendJson(store, res, reply.status, reply.body);
    return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(store, res, 401, { message: 'Requires authentication' });
      return;
    }
    const rawRemainder = pathname.slice('/api/v3'.length);
    const remainder = safeDecode(rawRemainder);
    const segments = remainder.split('/').filter((segment) => segment !== '');
    const reply = handleRest(store, {
      method,
      segments,
      remainder,
      query: url.searchParams,
      bodyText,
      selfUrl: `http://${req.headers.host ?? 'forge.local'}${pathname}`,
    });
    if (reply.status === 204) {
      res.writeHead(204, { 'X-GitHub-Request-Id': store.requestId() });
      res.end();
      return;
    }
    sendJson(store, res, reply.status, reply.body, reply.headers ?? {});
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch !== null) {
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'Bearer' });
      res.end('authentication required\n');
      return;
    }
    const owner = safeDecode(gitMatch[1] as string);
    const repoName = safeDecode(gitMatch[2] as string);
    const action = gitMatch[3] as string;
    const repo = store.getRepo(owner, repoName);
    if (action === 'info/refs' && method === 'GET') {
      const reply = infoRefs(repo, url.searchParams.get('service') ?? '', req.headers['git-protocol'] ?? '');
      res.writeHead(reply.status, { 'Content-Type': reply.contentType });
      res.end(reply.body);
      return;
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      const reply = uploadPack(repo, body);
      res.writeHead(reply.status, { 'Content-Type': reply.contentType });
      res.end(reply.body);
      return;
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      const reply = receivePack(repo, body);
      res.writeHead(reply.status, { 'Content-Type': reply.contentType });
      res.end(reply.body);
      return;
    }
    sendJson(store, res, 405, { message: 'Method Not Allowed' });
    return;
  }

  sendJson(store, res, 404, { message: 'Not Found' });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
