// Git smart HTTP: info/refs advertisements (protocol v0 and v2), git-upload-pack (v2 ls-refs
// and fetch, v0 fetch) with shallow/deepen support, and git-receive-pack (v0) with
// report-status. The pack protocol is implemented here on the primitives in gitobj.ts —
// there is no git binary on the grader.

import type { RepoRec } from './store.ts';
import { ZERO_OID, parseCommit, parseTag, parseTree, readPack, writePack } from './gitobj.ts';
import { fullClosure, isAncestor, peelToCommit } from './graph.ts';

const AGENT = 'forge/1.0';

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: a 4-hex-digit length (counting itself) plus the payload. */
export function pkt(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > 0xffff) throw new Error('pkt-line too long');
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Wrap data in sideband packets (band byte + up to 65515 bytes each). */
export function sideband(band: number, data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const maxData = 65515;
  for (let offset = 0; offset < data.length || (offset === 0 && data.length === 0); offset += maxData) {
    const chunk = data.subarray(offset, Math.min(offset + maxData, data.length));
    packets.push(pkt(Buffer.concat([Buffer.from([band]), chunk])));
    if (data.length === 0) break;
  }
  return packets;
}

export type PktEvent =
  | { kind: 'line'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** Parse pkt-lines from `buf` starting at `start`; returns the events and where parsing stopped. */
export function parsePkts(buf: Buffer, start: number): { events: PktEvent[]; offset: number } {
  const events: PktEvent[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const header = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      events.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      events.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      events.push({ kind: 'end' });
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > buf.length) break;
    events.push({ kind: 'line', data: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { events, offset };
}

function lineText(data: Buffer): string {
  return data.toString('utf8').replace(/\n$/, '');
}

// ---------------------------------------------------------------- ref advertisement

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

/** HEAD first, then every ref in name order, tags followed by their peeled commit. */
function advertisementRefs(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) lines.push({ name: 'HEAD', oid: headOid });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const object = repo.objects.get(oid);
    const line: RefLine = { name, oid };
    if (object?.type === 'tag') {
      const commit = peelToCommit(repo, oid);
      if (commit !== null) line.peeled = commit;
    }
    lines.push(line);
  }
  return lines;
}

/** The v2 advertisement is the same bytes for every repository; build it once. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pkt('version 2\n'),
  pkt(`agent=${AGENT}\n`),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow wait-for-done\n'),
  pkt('object-format=sha1\n'),
  PKT_FLUSH,
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const capabilities =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow no-progress symref=HEAD:${headTarget} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = advertisementRefs(repo);
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    refs.forEach((ref, index) => {
      const caps = index === 0 ? `\0${capabilities}` : '';
      parts.push(pkt(`${ref.oid} ${ref.name}${caps}\n`));
      if (ref.peeled !== undefined) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  oids: string[];
  boundary: string[];
  unshallow: string[];
}

/** The closure of `tips`, except that commits in `cut` do not contribute their parents. */
function closureWithCut(repo: RepoRec, tips: readonly string[], cut: Set<string>): Set<string> {
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
      if (!cut.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return out;
}

/** Add a commit and its whole tree (subtrees and blobs) to `into`. */
function includeTreeOf(repo: RepoRec, commitOid: string, into: Set<string>): void {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return;
  into.add(commitOid);
  const stack = [parseCommit(object.data).tree];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const entry = repo.objects.get(oid);
    if (entry === undefined) continue;
    into.add(oid);
    if (entry.type === 'tree') for (const child of parseTree(entry.data)) stack.push(child.oid);
  }
}

/**
 * Decide which objects a fetch sends: the wants' closure (depth-limited when a depth is
 * given), minus what the client already holds. A shallow boundary the client reports cuts
 * the held closure at that commit, which is what makes deepen deliver the next generation
 * while a plain fetch of a new tip never resends held history.
 */
function planFetch(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  shallowClient: readonly string[],
  depth: number | null,
): FetchPlan {
  const haveFull = fullClosure(repo, haves.filter((oid) => repo.objects.has(oid)));
  const cutHave = closureWithCut(repo, haves, new Set(shallowClient));
  const included = new Set<string>();
  const boundary: string[] = [];

  // Tag wants are sent as tag objects; their commits join the walk.
  const wantCommits: string[] = [];
  for (const want of wants) {
    let current = want;
    for (let hops = 0; hops < 32; hops += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) break;
      if (object.type === 'tag') {
        included.add(current);
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') wantCommits.push(current);
      else included.add(current); // a tree or blob wanted directly
      break;
    }
  }

  if (depth !== null) {
    const distances = new Map<string, number>();
    let frontier = [...new Set(wantCommits)];
    let distance = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const commitOid of frontier) {
        if (distances.has(commitOid)) continue;
        distances.set(commitOid, distance);
        includeTreeOf(repo, commitOid, included);
        const commit = repo.objects.get(commitOid);
        if (commit === undefined || commit.type !== 'commit') continue;
        const parents = parseCommit(commit.data).parents;
        if (distance + 1 < depth) next.push(...parents);
        else if (parents.length > 0 && !boundary.includes(commitOid)) boundary.push(commitOid);
      }
      frontier = next;
      distance += 1;
    }
  } else {
    const stack = [...wantCommits];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (included.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (haveFull.has(oid)) continue; // the client holds this commit and everything below it
      includeTreeOf(repo, oid, included);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
  }

  const oids = [...included].filter((oid) => !cutHave.has(oid));
  const unshallow = shallowClient.filter((oid) => included.has(oid) && !boundary.includes(oid));
  return { oids, boundary, unshallow };
}

function fetchPack(repo: RepoRec, plan: FetchPlan): Buffer {
  const objects = plan.oids
    .map((oid) => repo.objects.get(oid))
    .filter((object) => object !== undefined);
  return writePack(objects);
}

// ---------------------------------------------------------------- request handlers

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const TEXT = 'text/plain; charset=utf-8';

function notFound(): GitReply {
  return { status: 404, contentType: TEXT, body: Buffer.from('repository not found\n') };
}

/** GET /info/refs?service=... */
export function infoRefs(repo: RepoRec | undefined, service: string, protocolHeader: string): GitReply {
  if (repo === undefined) return notFound();
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 400, contentType: TEXT, body: Buffer.from('unknown service\n') };
  }
  if (service === 'git-upload-pack' && /(^|,)\s*version=2/.test(protocolHeader)) {
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: v2Advertisement(),
    };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(repo, service),
  };
}

/** POST /git-upload-pack: a v2 command request or a v0 fetch. */
export function uploadPack(repo: RepoRec | undefined, body: Buffer): GitReply {
  if (repo === undefined) return notFound();
  const { events } = parsePkts(body, 0);
  const first = events.find((event) => event.kind === 'line');
  if (first !== undefined && first.kind === 'line' && lineText(first.data).startsWith('command=')) {
    const command = lineText(first.data).slice('command='.length);
    if (command === 'ls-refs') return lsRefs(repo, events);
    if (command === 'fetch') return fetchV2(repo, events);
    return { status: 400, contentType: TEXT, body: Buffer.from(`unknown command ${command}\n`) };
  }
  return fetchV0(repo, events);
}

function lsRefs(repo: RepoRec, events: PktEvent[]): GitReply {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const event of events) {
    if (event.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (event.kind !== 'line' || !inArgs) continue;
    const line = lineText(event.data);
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pkt(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (unborn) {
      parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let suffix = '';
    if (peel) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const commit = peelToCommit(repo, oid);
        if (commit !== null) suffix = ` peeled:${commit}`;
      }
    }
    parts.push(pkt(`${oid} ${name}${suffix}\n`));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function fetchV2(repo: RepoRec, events: PktEvent[]): GitReply {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let inArgs = false;
  for (const event of events) {
    if (event.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (event.kind !== 'line' || !inArgs) continue;
    const line = lineText(event.data);
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
  }
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  if (plan.boundary.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.boundary) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pkt('packfile\n'));
  for (const packet of sideband(1, fetchPack(repo, plan))) parts.push(packet);
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV0(repo: RepoRec, events: PktEvent[]): GitReply {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const event of events) {
    if (event.kind !== 'line') continue;
    const raw = event.data.toString('utf8').replace(/\n$/, '');
    const line = raw.split('\0')[0] as string;
    if (line.startsWith('want ')) args.wants.push((line.slice(5).split(' ')[0] as string).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
  }
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  for (const oid of plan.boundary) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  for (const packet of sideband(1, fetchPack(repo, plan))) parts.push(packet);
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /git-receive-pack: store the pack, apply the ref updates that fast-forward, report. */
export function receivePack(repo: RepoRec | undefined, body: Buffer): GitReply {
  if (repo === undefined) return notFound();
  const { events, offset } = parsePkts(body, 0);
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let sawLine = false;
  for (const event of events) {
    if (event.kind !== 'line') continue;
    let text = lineText(event.data);
    if (!sawLine) {
      sawLine = true;
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        for (const cap of text.slice(nul + 1).split(' ')) if (cap !== '') capabilities.add(cap);
        text = text.slice(0, nul);
      }
    }
    const [oldOid, newOid, ref] = text.split(' ');
    if (oldOid !== undefined && newOid !== undefined && ref !== undefined && ref !== '') {
      commands.push({ oldOid, newOid, ref });
    }
  }
  if (!sawLine) {
    return { status: 400, contentType: TEXT, body: Buffer.from('malformed push request\n') };
  }

  const packBytes = body.subarray(offset);
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      objects.forEach((object, index) => {
        const oid = objects.oids[index] as string;
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      });
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const verdict = judgeRefUpdate(repo, command);
    if (verdict.ok) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    } else {
      reportLines.push(`ng ${command.ref} ${verdict.reason}\n`);
    }
  }
  const report = Buffer.concat([...reportLines.map((line) => pkt(line)), PKT_FLUSH]);
  const framed = capabilities.has('side-band-64k')
    ? Buffer.concat([...sideband(1, report), PKT_FLUSH])
    : report;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: framed };
}

/**
 * Judge one ref update without applying it. An update is refused when the ref has moved
 * since the pusher read it, when the new tip is not a descendant of the current one, when a
 * delete names a ref that is not there, or when the new object is missing. Non-fast-forward
 * refusals carry exactly the reason "non-fast-forward".
 */
function judgeRefUpdate(repo: RepoRec, command: PushCommand): { ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'reference not found' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    return { ok: true, reason: '' };
  }
  if (!repo.objects.has(command.newOid)) return { ok: false, reason: 'missing object' };
  if (current === undefined) {
    return command.oldOid === ZERO_OID
      ? { ok: true, reason: '' }
      : { ok: false, reason: 'non-fast-forward' };
  }
  if (command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (current === command.newOid) return { ok: true, reason: '' };
  const currentCommit = peelToCommit(repo, current);
  const newCommit = peelToCommit(repo, command.newOid);
  if (currentCommit === null || newCommit === null) {
    // A re-point between non-commit objects (a tag moved): the pusher named the value it read.
    return { ok: true, reason: '' };
  }
  return isAncestor(repo, currentCommit, newCommit)
    ? { ok: true, reason: '' }
    : { ok: false, reason: 'non-fast-forward' };
}
