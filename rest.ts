// The REST v3 surface under /api/v3: the API root, meta, the viewer, repositories and their
// branches, commits, contents and git refs, labels, issues and comments, and pull requests
// with files and squash merges. Shapes follow GitHub's: JSON bodies, {message} errors, Link
// pagination, 201 on create, 204 on delete, 409 on a stale contents sha, 405 on a merge that
// cannot be taken.

import { globalId, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';
import { identSeconds, parseCommit } from './gitobj.ts';
import {
  commitTreeOid,
  diffTrees,
  flattenTree,
  makeCommit,
  mergeBase,
  putObject,
  refCommit,
  setTreePath,
  threeWayMergeTrees,
  treeEntries,
} from './graph.ts';

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const NOT_FOUND: RestReply = { status: 404, body: { message: 'Not Found' } };

function fail(status: number, message: string): RestReply {
  return { status, body: { message } };
}

class BadJson extends Error {}

function jsonBody(text: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    throw new BadJson('Problems parsing JSON');
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function userJson(store: Store): Record<string, unknown> {
  const viewer = store.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: globalId('User', viewer.id),
    name: viewer.name,
    email: viewer.email,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(store: Store, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: store.viewer.id, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 1000000007;
  return {
    id: hash,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

/** The stable REST id of an issue or pull: unique per repository and number. */
function issueId(repo: RepoRec, number: number): number {
  return repo.id * 1000000 + number;
}

export function issueJson(store: Store, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issueId(repo, issue.number),
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

export function commentJson(store: Store, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function refJson(store: Store, repo: RepoRec, pull: PullRec, side: 'head' | 'base'): Record<string, unknown> {
  const ref = side === 'head' ? pull.headRef : pull.baseRef;
  const snapshot = side === 'head' ? pull.headSha : pull.baseSha;
  const live = repo.refs.get(`refs/heads/${ref}`);
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha: live ?? snapshot,
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    repo: {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.isPrivate,
      owner: { login: repo.owner, id: store.viewer.id, type: 'User' },
      description: repo.description,
      default_branch: repo.defaultBranch,
    },
  };
}

export function pullJson(store: Store, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: issueId(repo, pull.number),
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: refJson(store, repo, pull, 'head'),
    base: refJson(store, repo, pull, 'base'),
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    comments: pull.comments.length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' || pull.merged ? pull.updatedAt : null,
    merged_by: pull.merged ? { login: store.viewer.login, id: store.viewer.id, type: 'User' } : null,
    draft: false,
  };
}

interface Page {
  items: unknown[];
  link: string | null;
}

/** Slice a list by page/per_page and build the Link header for the pages around it. */
function paginate(items: unknown[], query: URLSearchParams, baseUrl: string): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => `${baseUrl}?page=${p}&per_page=${perPage}`;
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`, `<${urlFor(1)}>; rel="first"`);
  return { items: slice, link: links.length > 0 ? links.join(', ') : null };
}

function withPage(page: Page, status = 200): RestReply {
  return {
    status,
    body: page.items,
    headers: page.link !== null ? { Link: page.link } : undefined,
  };
}

// ---------------------------------------------------------------- routing

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, percent-decoded. */
  segments: string[];
  /** The raw remainder after /api/v3 (for routes whose last segment may contain slashes). */
  remainder: string;
  query: URLSearchParams;
  bodyText: string;
  /** Absolute URL of this request, for pagination links. */
  selfUrl: string;
}

export function handleRest(store: Store, request: RestRequest): RestReply {
  try {
    return route(store, request);
  } catch (err) {
    if (err instanceof BadJson) return fail(400, 'Problems parsing JSON');
    throw err;
  }
}

function route(store: Store, request: RestRequest): RestReply {
  const { method, segments } = request;
  if (segments.length === 0) {
    if (method !== 'GET') return NOT_FOUND;
    return {
      status: 200,
      body: {
        current_user_url: 'api/v3/user',
        repository_url: 'api/v3/repos/{owner}/{repo}',
        issue_search_url: 'api/v3/search/issues?q={query}',
        emojis_url: 'api/v3/emojis',
      },
      headers: { 'X-OAuth-Scopes': 'repo, read:org' },
    };
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    return method === 'GET' ? { status: 200, body: { installed_version: '1.0.0' } } : NOT_FOUND;
  }
  if (segments[0] === 'user' && segments.length === 1) {
    return method === 'GET' ? { status: 200, body: userJson(store) } : NOT_FOUND;
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = store.viewerRepos().map((repo) => repoJson(store, repo));
      return withPage(paginate(repos, request.query, request.selfUrl));
    }
    if (method === 'POST') return createRepo(store, request);
    return NOT_FOUND;
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = store.getRepo(owner, name);
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') return repo === undefined ? NOT_FOUND : { status: 200, body: repoJson(store, repo) };
      if (method === 'PATCH') return repo === undefined ? NOT_FOUND : patchRepo(store, repo, request);
      if (method === 'DELETE') {
        if (repo === undefined) return NOT_FOUND;
        store.deleteRepo(owner, name);
        return { status: 204 };
      }
      return NOT_FOUND;
    }
    if (repo === undefined) return NOT_FOUND;
    return repoRoute(store, repo, rest, request);
  }
  return NOT_FOUND;
}

function createRepo(store: Store, request: RestRequest): RestReply {
  const body = jsonBody(request.bodyText);
  const name = str(body.name);
  if (name === '') return fail(422, 'Validation Failed: name is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return fail(422, 'Validation Failed: name is invalid');
  const repo = store.createRepo(name, str(body.description), body.private === true);
  if (repo === null) return fail(422, 'Validation Failed: name already exists on this account');
  if (body.auto_init === true) {
    const readme = putObject(repo, 'blob', Buffer.from(`# ${name}\n`, 'utf8'));
    const tree = setTreePath(repo, null, ['README.md'], readme);
    const commit = makeCommit(store, repo, { tree, parents: [], message: 'Initial commit' });
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
  }
  return { status: 201, body: repoJson(store, repo) };
}

function patchRepo(store: Store, repo: RepoRec, request: RestRequest): RestReply {
  const body = jsonBody(request.bodyText);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  if (typeof body.default_branch === 'string' && body.default_branch !== '') {
    repo.defaultBranch = body.default_branch;
  }
  if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
    const oldKey = `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
    repo.name = body.name;
    store.repos.delete(oldKey);
    store.repos.set(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`, repo);
  }
  repo.updatedAt = store.nowIso();
  return { status: 200, body: repoJson(store, repo) };
}

// ---------------------------------------------------------------- inside a repository

function repoRoute(store: Store, repo: RepoRec, rest: string[], request: RestRequest): RestReply {
  const { method } = request;
  const head = rest[0] as string;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(ref) as string },
          protected: false,
        }));
      return { status: 200, body: branches };
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = request.remainder.split('/branches/')[1] ?? rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return NOT_FOUND;
      return { status: 200, body: { name: branch, commit: { sha }, protected: false } };
    }
    return NOT_FOUND;
  }

  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    return listCommits(repo, request);
  }

  if (head === 'contents') {
    const path = (request.remainder.split('/contents/')[1] ?? '').replace(/^\/+/, '');
    const segments = path === '' ? [] : path.split('/');
    if (method === 'GET') return getContents(repo, segments, request);
    if (method === 'PUT') return putContents(store, repo, segments, request);
    if (method === 'DELETE') return deleteContents(store, repo, segments, request);
    return NOT_FOUND;
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const body = jsonBody(request.bodyText);
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
        return fail(422, 'Validation Failed: ref or sha is invalid');
      }
      if (repo.refs.has(ref)) return fail(422, 'Validation Failed: Reference already exists');
      repo.refs.set(ref, sha);
      const object = repo.objects.get(sha) as { type: string };
      return { status: 201, body: { ref, object: { sha, type: object.type } } };
    }
    if (method === 'GET') {
      const tail = request.remainder.split('/git/refs/')[1] ?? '';
      const full = tail.startsWith('refs/') ? tail : `refs/${tail}`;
      const sha = repo.refs.get(full);
      if (sha === undefined) return NOT_FOUND;
      const object = repo.objects.get(sha);
      return { status: 200, body: { ref: full, object: { sha, type: object?.type ?? 'commit' } } };
    }
    return NOT_FOUND;
  }

  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = jsonBody(request.bodyText);
      const name = str(body.name);
      if (name === '') return fail(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return fail(422, 'Validation Failed: Label already exists');
      repo.labels.set(name, {
        name,
        color: str(body.color) || 'ededed',
        description: typeof body.description === 'string' ? body.description : null,
      });
      return { status: 201, body: labelJson(repo, name) };
    }
    if (method === 'GET' && rest.length === 1) {
      return { status: 200, body: [...repo.labels.keys()].sort().map((name) => labelJson(repo, name)) };
    }
    return NOT_FOUND;
  }

  if (head === 'issues') return issuesRoute(store, repo, rest, request);
  if (head === 'pulls') return pullsRoute(store, repo, rest, request);
  return NOT_FOUND;
}

function listCommits(repo: RepoRec, request: RestRequest): RestReply {
  const shaParam = request.query.get('sha');
  let start: string | null = null;
  if (shaParam !== null && shaParam !== '') {
    start =
      refCommit(repo, `refs/heads/${shaParam}`) ??
      (repo.objects.get(shaParam)?.type === 'commit' ? shaParam : null);
    if (start === null) return NOT_FOUND;
  } else {
    start = refCommit(repo, `refs/heads/${repo.defaultBranch}`);
    if (start === null) return { status: 200, body: [] };
  }
  // Breadth-first from the tip: parents after children, newest first.
  const seen = new Set<string>();
  const order: string[] = [];
  let frontier = [start];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      order.push(oid);
      for (const parent of parseCommit(object.data).parents) next.push(parent);
    }
    frontier = next;
  }
  const commits = order.map((oid) => {
    const commit = parseCommit((repo.objects.get(oid) as { data: Buffer }).data);
    const ident = (line: string): { name: string; email: string; date: string } => {
      const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
      return {
        name: match?.[1] ?? '',
        email: match?.[2] ?? '',
        date: new Date(identSeconds(line) * 1000).toISOString(),
      };
    };
    return {
      sha: oid,
      commit: {
        message: commit.message.replace(/\n$/, ''),
        author: ident(commit.author),
        committer: ident(commit.committer),
        tree: { sha: commit.tree },
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  });
  return withPage(paginate(commits, request.query, request.selfUrl));
}

// ---------------------------------------------------------------- contents

/** The commit a ?ref= value names: a branch, a commit id, or the default branch. */
function resolveRef(repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === '') return refCommit(repo, `refs/heads/${repo.defaultBranch}`);
  return (
    refCommit(repo, `refs/heads/${ref}`) ??
    (repo.objects.get(ref)?.type === 'commit' ? ref : null)
  );
}

function getContents(repo: RepoRec, segments: string[], request: RestRequest): RestReply {
  const commit = resolveRef(repo, request.query.get('ref'));
  if (commit === null) return NOT_FOUND;
  const tree = commitTreeOid(repo, commit);
  if (tree === null) return NOT_FOUND;
  if (segments.length === 0) {
    return { status: 200, body: treeEntries(repo, tree).map((entry) => contentEntry(repo, entry, entry.name)) };
  }
  let currentTree: string | null = tree;
  for (let i = 0; i < segments.length; i += 1) {
    if (currentTree === null) return NOT_FOUND;
    const entry = treeEntries(repo, currentTree).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return NOT_FOUND;
    const path = segments.slice(0, i + 1).join('/');
    if (i === segments.length - 1) {
      if (entry.mode === '40000') {
        return {
          status: 200,
          body: treeEntries(repo, entry.oid).map((child) => contentEntry(repo, child, `${path}/${child.name}`)),
        };
      }
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined) return NOT_FOUND;
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          name: entry.name,
          path,
          sha: entry.oid,
          size: blob.data.length,
          content: blob.data.toString('base64'),
        },
      };
    }
    if (entry.mode !== '40000') return NOT_FOUND;
    currentTree = entry.oid;
  }
  return NOT_FOUND;
}

function contentEntry(
  repo: RepoRec,
  entry: { mode: string; name: string; oid: string },
  path: string,
): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
    size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
  };
}

/** The branch a contents write targets, and its current tip (null when unborn). */
function writeTarget(repo: RepoRec, body: Record<string, unknown>): { branch: string; tip: string | null } {
  const branch = str(body.branch) || repo.defaultBranch;
  return { branch, tip: repo.refs.get(`refs/heads/${branch}`) ?? null };
}

function putContents(store: Store, repo: RepoRec, segments: string[], request: RestRequest): RestReply {
  if (segments.length === 0) return fail(422, 'Validation Failed: path is required');
  const body = jsonBody(request.bodyText);
  const message = str(body.message);
  const encoded = str(body.content);
  const { branch, tip } = writeTarget(repo, body);
  // A write to a branch that does not exist yet starts from the default branch's tip.
  const parent = tip ?? refCommit(repo, `refs/heads/${repo.defaultBranch}`);
  const parentTree = parent === null ? null : commitTreeOid(repo, parent);
  const path = segments.join('/');
  const existing = parentTree === null ? null : flattenTree(repo, parentTree).get(path)?.oid ?? null;
  if (existing !== null && typeof body.sha === 'string' && body.sha !== existing) {
    return fail(409, 'Conflict: the sha does not match the current content');
  }
  const blob = putObject(repo, 'blob', Buffer.from(encoded, 'base64'));
  const tree = setTreePath(repo, parentTree, segments, blob);
  const commit = makeCommit(store, repo, {
    tree,
    parents: parent === null ? [] : [parent],
    message,
  });
  repo.refs.set(`refs/heads/${branch}`, commit);
  return {
    status: existing === null ? 201 : 200,
    body: {
      content: {
        type: 'file',
        encoding: 'base64',
        name: segments[segments.length - 1] as string,
        path,
        sha: blob,
        size: Buffer.from(encoded, 'base64').length,
      },
      commit: { sha: commit, message },
    },
  };
}

function deleteContents(store: Store, repo: RepoRec, segments: string[], request: RestRequest): RestReply {
  if (segments.length === 0) return NOT_FOUND;
  const body = jsonBody(request.bodyText);
  const message = str(body.message);
  const { branch, tip } = writeTarget(repo, body);
  if (tip === null) return NOT_FOUND;
  const parentTree = commitTreeOid(repo, tip);
  if (parentTree === null) return NOT_FOUND;
  const path = segments.join('/');
  const existing = flattenTree(repo, parentTree).get(path)?.oid ?? null;
  if (existing === null) return NOT_FOUND;
  if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing) {
    return fail(409, 'Conflict: the sha does not match the current content');
  }
  const tree = setTreePath(repo, parentTree, segments, null);
  const commit = makeCommit(store, repo, { tree, parents: [tip], message });
  repo.refs.set(`refs/heads/${branch}`, commit);
  return { status: 200, body: { content: null, commit: { sha: commit, message } } };
}

// ---------------------------------------------------------------- issues

function issuesRoute(store: Store, repo: RepoRec, rest: string[], request: RestRequest): RestReply {
  const { method } = request;
  if (rest.length === 1) {
    if (method === 'POST') {
      const body = jsonBody(request.bodyText);
      const title = str(body.title);
      if (title === '') return fail(422, 'Validation Failed: title is required');
      const labelNames: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const label of body.labels) {
          const name = typeof label === 'string' ? label : str((label as Record<string, unknown>)?.name);
          if (!repo.labels.has(name)) {
            return fail(422, `Validation Failed: label "${name}" does not exist`);
          }
          labelNames.push(name);
        }
      }
      const stamp = store.nowIso();
      const issue: IssueRec = {
        number: repo.nextNumber,
        title,
        body: str(body.body),
        state: 'open',
        labels: labelNames,
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
        tick: repo.nextNumber,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { status: 201, body: issueJson(store, repo, issue) };
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const direction = request.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return withPage(
        paginate(issues.map((issue) => issueJson(store, repo, issue)), request.query, request.selfUrl),
      );
    }
    return NOT_FOUND;
  }
  const number = Number(rest[1]);
  if (!Number.isSafeInteger(number) || number <= 0) return NOT_FOUND;
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);
  if (rest.length === 2) {
    if (issue === undefined) return NOT_FOUND;
    if (method === 'GET') return { status: 200, body: issueJson(store, repo, issue) };
    if (method === 'PATCH') {
      const body = jsonBody(request.bodyText);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const names: string[] = [];
        for (const label of body.labels) {
          const name = typeof label === 'string' ? label : str((label as Record<string, unknown>)?.name);
          if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
          names.push(name);
        }
        issue.labels = names;
      }
      issue.updatedAt = store.nowIso();
      return { status: 200, body: issueJson(store, repo, issue) };
    }
    return NOT_FOUND;
  }
  if (rest.length === 3 && rest[2] === 'comments') {
    const host = issue ?? pull;
    if (host === undefined) return NOT_FOUND;
    if (method === 'POST') {
      const body = jsonBody(request.bodyText);
      const text = str(body.body);
      if (text === '') return fail(422, 'Validation Failed: body is required');
      const stamp = store.nowIso();
      const comment = { id: store.nextCommentId(), body: text, createdAt: stamp, updatedAt: stamp };
      host.comments.push(comment);
      return { status: 201, body: commentJson(store, comment) };
    }
    if (method === 'GET') {
      return { status: 200, body: host.comments.map((comment) => commentJson(store, comment)) };
    }
  }
  return NOT_FOUND;
}

// ---------------------------------------------------------------- pull requests

function pullsRoute(store: Store, repo: RepoRec, rest: string[], request: RestRequest): RestReply {
  const { method } = request;
  if (rest.length === 1) {
    if (method === 'POST') {
      const body = jsonBody(request.bodyText);
      const stripOwner = (ref: string): string => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);
      const head = stripOwner(str(body.head));
      const base = stripOwner(str(body.base));
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (head === '' || base === '' || headSha === undefined || baseSha === undefined) {
        return fail(422, 'Validation Failed: head or base branch does not exist');
      }
      const stamp = store.nowIso();
      const pull: PullRec = {
        number: repo.nextNumber,
        title: str(body.title),
        body: str(body.body),
        state: 'open',
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
      return { status: 201, body: pullJson(store, repo, pull) };
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open' && !pull.merged);
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed' || pull.merged);
      pulls.sort((a, b) => b.number - a.number);
      return withPage(
        paginate(pulls.map((pull) => pullJson(store, repo, pull)), request.query, request.selfUrl),
      );
    }
    return NOT_FOUND;
  }
  const number = Number(rest[1]);
  if (!Number.isSafeInteger(number) || number <= 0) return NOT_FOUND;
  const pull = repo.pulls.get(number);
  if (pull === undefined) return NOT_FOUND;
  if (rest.length === 2 && method === 'GET') return { status: 200, body: pullJson(store, repo, pull) };
  if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
    const headCommit = refCommit(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseCommit = refCommit(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = mergeBase(repo, baseCommit, headCommit);
    const fromTree = base === null ? null : commitTreeOid(repo, base);
    const toTree = commitTreeOid(repo, headCommit);
    const files = diffTrees(repo, fromTree, toTree).map((diff) => ({
      filename: diff.filename,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.changes,
      sha: '',
    }));
    return { status: 200, body: files };
  }
  if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
    return mergePull(store, repo, pull, request);
  }
  return NOT_FOUND;
}

/** Squash (or, with merge_method "merge", two-parent) merge of a pull request. */
export function mergePullRecord(store: Store, repo: RepoRec, pull: PullRec, method: string): { sha: string } | { error: number; message: string } {
  if (pull.merged) return { error: 405, message: 'Pull Request is already merged' };
  if (pull.state === 'closed') return { error: 405, message: 'Pull Request is closed' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return { error: 405, message: 'The base branch is gone' };
  const baseCommit = refCommit(repo, `refs/heads/${pull.baseRef}`) ?? baseTip;
  const headCommit = refCommit(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
  const base = mergeBase(repo, baseCommit, headCommit);
  const outcome = threeWayMergeTrees(
    repo,
    base === null ? null : commitTreeOid(repo, base),
    commitTreeOid(repo, baseCommit),
    commitTreeOid(repo, headCommit),
  );
  if (outcome.tree === null) {
    return { error: 405, message: `Merge conflict in ${outcome.conflictPath ?? 'a file'}` };
  }
  let sha: string;
  if (method === 'merge') {
    sha = makeCommit(store, repo, {
      tree: outcome.tree,
      parents: [baseCommit, headCommit],
      message: `Merge pull request #${pull.number} from ${pull.headRef}`,
    });
  } else {
    const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
    sha = makeCommit(store, repo, { tree: outcome.tree, parents: [baseCommit], message });
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const stamp = store.nowIso();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = stamp;
  pull.mergeCommitSha = sha;
  pull.updatedAt = stamp;
  return { sha };
}

function mergePull(store: Store, repo: RepoRec, pull: PullRec, request: RestRequest): RestReply {
  const body = jsonBody(request.bodyText);
  const method = str(body.merge_method) || 'squash';
  const result = mergePullRecord(store, repo, pull, method);
  if ('error' in result) return fail(result.error, result.message);
  return {
    status: 200,
    body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' },
  };
}
