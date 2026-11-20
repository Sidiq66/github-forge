// The forge's single in-memory store: repositories with their git objects and refs, plus the
// issues, pull requests, labels and comments the API surfaces serve. Every surface (git smart
// HTTP, REST, GraphQL, MCP) reads and writes this one store, so an object created through one
// surface is the same object through all the others.
//
// Determinism: nothing here reads the wall clock or a random source. Timestamps come from a
// logical clock — a fixed epoch plus a monotonic counter — and ids from counters, so two runs
// that take the same requests produce byte-identical answers.

export const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z

export interface Viewer {
  id: number;
  login: string;
  name: string;
  email: string;
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  tick: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  tick: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

const VIEWER: Viewer = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export class Store {
  readonly viewer: Viewer;
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private commentSeq = 0;
  private requestSeq = 0;
  private clock = 0;

  constructor() {
    const override = (process.env.MAKEFUN_FORGE_LOGIN ?? '').trim();
    this.viewer =
      override === ''
        ? { ...VIEWER }
        : { id: VIEWER.id, login: override, name: VIEWER.name, email: `${override}@example.invalid` };
  }

  /** The next logical timestamp, in epoch seconds: fixed epoch + a monotonic counter. */
  tickSec(): number {
    this.clock += 1;
    return EPOCH_SEC + this.clock;
  }

  /** The next logical timestamp as an ISO string. */
  nowIso(): string {
    return new Date(this.tickSec() * 1000).toISOString();
  }

  /** An ISO string for a logical second handed out earlier. */
  static isoOf(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }

  /** A deterministic, non-empty request id. */
  requestId(): string {
    this.requestSeq += 1;
    return this.requestSeq.toString(16).padStart(8, '0').toUpperCase();
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  static repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): RepoRec | null {
    const key = Store.repoKey(this.viewer.login, name);
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    const stamp = this.nowIso();
    const repo: RepoRec = {
      id: this.repoSeq,
      owner: this.viewer.login,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.repoKey(owner, name));
  }

  /** The viewer's repositories in creation order. */
  viewerRepos(): RepoRec[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner.toLowerCase() === this.viewer.login.toLowerCase())
      .sort((a, b) => a.id - b.id);
  }
}

/** Memoised globalId results: the encoding of a given id never changes. */
const globalIdCache = new Map<string, string>();

/** An opaque, stable GraphQL global id for a stored object, e.g. Issue:<repoId>:<number>. */
export function globalId(type: string, ...parts: Array<string | number>): string {
  const joined = [type, ...parts.map(String)].join(':');
  let id = globalIdCache.get(joined);
  if (id === undefined) {
    id = Buffer.from(joined, 'utf8').toString('base64');
    globalIdCache.set(joined, id);
  }
  return id;
}

/** The parts a global id was built from, or null when the string is not one of ours. */
export function parseGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    const type = parts.shift();
    if (type === undefined || type === '' || parts.length === 0) return null;
    return { type, parts };
  } catch {
    return null;
  }
}
