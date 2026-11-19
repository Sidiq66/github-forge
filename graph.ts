// Object-graph operations over a repository's store: peeling tags, walking commit ancestry,
// flattening and rebuilding trees, three-way merges for pull requests, and tree diffs. Used by
// the git transport, the contents API and the merge endpoint alike, so every surface agrees
// about what a commit contains.

import type { GitObject, RepoRec, Store } from './store.ts';
import {
  buildCommit,
  buildTree,
  hashObject,
  identLine,
  parseCommit,
  parseTag,
  parseTree,
  type TreeEntry,
} from './gitobj.ts';

export function putObject(repo: RepoRec, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Follow tag objects until a non-tag object; returns that object's id, or null if missing. */
export function peelToNonTag(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return null;
}

/** The commit an object (commit or tag) ultimately points at, or null. */
export function peelToCommit(repo: RepoRec, oid: string): string | null {
  const target = peelToNonTag(repo, oid);
  if (target === null) return null;
  return repo.objects.get(target)?.type === 'commit' ? target : null;
}

/** The commit a ref names (through tags), or null when the ref is absent or not a commit. */
export function refCommit(repo: RepoRec, ref: string): string | null {
  const oid = repo.refs.get(ref);
  return oid === undefined ? null : peelToCommit(repo, oid);
}

export function commitTreeOid(repo: RepoRec, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Every path in a tree, mapped to its blob id and mode. */
export function flattenTree(repo: RepoRec, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The entries directly inside a tree (or a subtree named by the first segment). */
export function treeEntries(repo: RepoRec, treeOid: string): TreeEntry[] {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/** Build nested trees from a flat path -> blob map; returns the root tree id. */
export function buildTreeFromFlat(repo: RepoRec, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return emit(root);
}

/**
 * Return a new tree with `segments` set to `blobOid` (or removed when blobOid is null),
 * starting from `treeOid` (or an empty tree). Intermediate trees are created as needed.
 */
export function setTreePath(
  repo: RepoRec,
  treeOid: string | null,
  segments: readonly string[],
  blobOid: string | null,
): string {
  const entries = treeOid === null ? [] : treeEntries(repo, treeOid);
  const head = segments[0] as string;
  const rest = segments.slice(1);
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const child = setTreePath(repo, existing?.oid ?? null, rest, blobOid);
    // Drop directories left empty by a removal.
    const childEntries = treeEntries(repo, child);
    if (blobOid !== null || childEntries.length > 0) {
      kept.push({ mode: '40000', name: head, oid: child });
    }
  }
  return putObject(repo, 'tree', buildTree(kept));
}

/** The blob id at a path inside a tree, or null. */
export function blobAtPath(repo: RepoRec, treeOid: string, path: string): string | null {
  const flat = flattenTree(repo, treeOid);
  return flat.get(path)?.oid ?? null;
}

/** Create a commit object in the repo, authored by the viewer at the store's logical time. */
export function makeCommit(
  store: Store,
  repo: RepoRec,
  input: { tree: string; parents: string[]; message: string },
): string {
  const ts = store.tickSec();
  const ident = identLine(store.viewer.name, store.viewer.email, ts);
  return putObject(
    repo,
    'commit',
    buildCommit({ tree: input.tree, parents: input.parents, author: ident, committer: ident, message: input.message }),
  );
}

/** Every commit reachable from `start`, with its shortest distance from `start`. */
export function ancestorDistances(repo: RepoRec, start: string): Map<string, number> {
  const distances = new Map<string, number>();
  let frontier = [start];
  let distance = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (distances.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      distances.set(oid, distance);
      for (const parent of parseCommit(object.data).parents) next.push(parent);
    }
    frontier = next;
    distance += 1;
  }
  return distances;
}

export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  // Depth-first from the descendant, stopping the moment the ancestor turns up: a
  // fast-forward check usually resolves in a step or two.
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits (least total distance), or null. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const fromA = ancestorDistances(repo, a);
  const fromB = ancestorDistances(repo, b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, distA] of fromA) {
    const distB = fromB.get(oid);
    if (distB !== undefined && distA + distB < bestScore) {
      bestScore = distA + distB;
      best = oid;
    }
  }
  return best;
}

/** Every object reachable from the given tips: commits, their trees and blobs, and tags. */
export function fullClosure(repo: RepoRec, tips: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return out;
}

export interface MergeOutcome {
  tree: string | null;
  conflictPath: string | null;
}

/**
 * Three-way merge of flattened trees: for each path, if only one side changed it relative to
 * the base, take that side; if both changed it differently, that path conflicts.
 */
export function threeWayMergeTrees(
  repo: RepoRec,
  baseTree: string | null,
  ourTree: string | null,
  theirTree: string | null,
): MergeOutcome {
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const ours = ourTree === null ? new Map() : flattenTree(repo, ourTree);
  const theirs = theirTree === null ? new Map() : flattenTree(repo, theirTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, { oid: string; mode: string }>();
  for (const path of paths) {
    const b = base.get(path)?.oid;
    const o = ours.get(path)?.oid;
    const t = theirs.get(path)?.oid;
    if (o === t) {
      const keep = ours.get(path) ?? theirs.get(path);
      if (keep !== undefined) merged.set(path, keep);
    } else if (b === o) {
      const keep = theirs.get(path);
      if (keep !== undefined) merged.set(path, keep);
    } else if (b === t) {
      const keep = ours.get(path);
      if (keep !== undefined) merged.set(path, keep);
    } else {
      return { tree: null, conflictPath: path };
    }
  }
  return { tree: buildTreeFromFlat(repo, merged), conflictPath: null };
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line-level diff counts between two texts, via a longest-common-subsequence walk. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const m = oldLines.length;
  const n = newLines.length;
  const dp = new Uint32Array(n + 1);
  for (let i = m - 1; i >= 0; i -= 1) {
    let prev = 0;
    for (let j = n - 1; j >= 0; j -= 1) {
      const saved = dp[j] as number;
      dp[j] = oldLines[i] === newLines[j] ? prev + 1 : Math.max(dp[j] as number, dp[j + 1] as number);
      prev = saved;
    }
  }
  const common = dp[0] as number;
  return { additions: n - common, deletions: m - common };
}

/** The file-level diff between two trees (either may be null for an empty tree). */
export function diffTrees(repo: RepoRec, fromTree: string | null, toTree: string | null): FileDiff[] {
  const from = fromTree === null ? new Map() : flattenTree(repo, fromTree);
  const to = toTree === null ? new Map() : flattenTree(repo, toTree);
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  const diffs: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before?.oid === after?.oid) continue;
    const oldText = before === undefined ? '' : (repo.objects.get(before.oid)?.data.toString('utf8') ?? '');
    const newText = after === undefined ? '' : (repo.objects.get(after.oid)?.data.toString('utf8') ?? '');
    const counts =
      before === undefined
        ? { additions: newText === '' ? 0 : newText.split('\n').length, deletions: 0 }
        : after === undefined
          ? { additions: 0, deletions: oldText === '' ? 0 : oldText.split('\n').length }
          : lineDiffCounts(oldText, newText);
    diffs.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return diffs;
}
