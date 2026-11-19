// Git object and packfile primitives on node:crypto and node:zlib alone: sha1 object ids,
// tree/commit/tag (de)serialisation, pack writing, and pack reading with OFS_DELTA / REF_DELTA
// resolution (including thin packs, whose bases are looked up in the receiving repository).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjType } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_TO_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of an object: sha1 of "<type> <size>\0" followed by the raw bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------- trees and commits

export interface TreeEntry {
  mode: string; // '100644', '100755', '120000' for files; '40000' for directories
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode terminator');
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Serialise tree entries in git's order: by name, directories sorting as if suffixed with '/'. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** A git identity line, e.g. "ada iversen <adaiversen@example.invalid> 1735689601 +0000". */
export function identLine(name: string, email: string, tsSec: number): string {
  return `${name} <${email}> ${tsSec} +0000`;
}

/** The seconds from an identity line's timestamp, or 0 when it does not parse. */
export function identSeconds(ident: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(ident);
  return match ? Number(match[1]) : 0;
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

// ---------------------------------------------------------------- packs

/** One packfile: "PACK", version 2, the objects zlib-deflated with no deltas, sha1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(encodePackEntryHeader(TYPE_TO_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

function encodePackEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

interface RawPackEntry {
  type: ObjType | 'ofs-delta' | 'ref-delta';
  data: Buffer; // the inflated payload (the delta bytes for delta entries)
  baseOffset: number; // for ofs-delta: the pack offset of the base entry
  baseOid: string; // for ref-delta: the base object's id
  offset: number;
}

/**
 * Read a packfile into full objects. Delta bases are resolved inside the pack first, then
 * through `lookup` (a thin pack's bases live in the receiving repository). The trailer
 * checksum is verified.
 */
export function readPack(
  pack: Buffer,
  lookup?: (oid: string) => GitObject | undefined,
): GitObject[] & { oids: string[] } {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.toString('hex', pack.length - 20);
  if (sha1Hex(pack.subarray(0, pack.length - 20)) !== trailer) {
    throw new Error('pack checksum mismatch');
  }
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseOid = '';
    if (code === 6) {
      byte = pack[offset];
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        back = (back + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = start - back;
    } else if (code === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch');
    offset += inflated.engine.bytesWritten;
    const type =
      code === 6 ? 'ofs-delta' : code === 7 ? 'ref-delta' : (CODE_TO_TYPE[code] as ObjType | undefined);
    if (type === undefined) throw new Error(`unknown pack object type ${code}`);
    raw.push({ type, data: inflated.buffer, baseOffset, baseOid, offset: start });
    byOffset.set(start, raw.length - 1);
  }

  const plainOidIndex = new Map<string, number>();
  raw.forEach((entry, index) => {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      plainOidIndex.set(hashObject(entry.type, entry.data), index);
    }
  });

  const resolved: Array<GitObject | null> = raw.map(() => null);
  const resolve = (index: number): GitObject => {
    const cached = resolved[index];
    if (cached !== null) return cached;
    const entry = raw[index] as RawPackEntry;
    let object: GitObject;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: GitObject | undefined;
      if (entry.type === 'ofs-delta') {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('ofs-delta base is not in the pack');
        base = resolve(baseIndex);
      } else {
        let baseIndex = plainOidIndex.get(entry.baseOid);
        if (baseIndex === undefined) {
          // The base may be a delta entry earlier in the pack that is already resolved.
          for (let i = 0; i < raw.length; i += 1) {
            const candidate = resolved[i];
            if (candidate !== null && hashObject(candidate.type, candidate.data) === entry.baseOid) {
              baseIndex = i;
              break;
            }
          }
        }
        if (baseIndex !== undefined) base = resolve(baseIndex);
        else base = lookup?.(entry.baseOid);
        if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    resolved[index] = object;
    return object;
  };

  const objects: GitObject[] = [];
  const oids: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const object = resolve(index);
    objects.push(object);
    oids.push(hashObject(object.type, object.data));
  }
  return Object.assign(objects, { oids });
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const cmd = delta[offset] as number;
    offset += 1;
    if (cmd & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (cmd & 0x01) { copyOffset = delta[offset] as number; offset += 1; }
      if (cmd & 0x02) { copyOffset += (delta[offset] as number) * 256; offset += 1; }
      if (cmd & 0x04) { copyOffset += (delta[offset] as number) * 65536; offset += 1; }
      if (cmd & 0x08) { copyOffset += (delta[offset] as number) * 16777216; offset += 1; }
      if (cmd & 0x10) { copySize = delta[offset] as number; offset += 1; }
      if (cmd & 0x20) { copySize += (delta[offset] as number) * 256; offset += 1; }
      if (cmd & 0x40) { copySize += (delta[offset] as number) * 65536; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (cmd > 0) {
      parts.push(delta.subarray(offset, offset + cmd));
      offset += cmd;
      produced += cmd;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}
