// mend — the CLI of SPEC.md, version 1. Node 22, the standard library alone.
// Implements sections 1 to 10: the command line, output and exit codes, safe paths, format detection,
// three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits, and the
// all-or-nothing write.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): that hand-over and runner.ts are kept as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const rtrim = (s: string): string => s.replace(/[ \t]+$/, '');
const btrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** `--strict` narrows matching to tier 0 alone (SPEC.md section 5). Set once, from the command line. */
let STRICT = false;

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as SPEC.md section 3 sees it: its lines, whether it ends with a break, and which break. */
interface Doc {
  lines: string[];
  final: boolean;
  br: string;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], final: false, br: '\n' };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, final, br };
}

function render(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** One line of an edit's N: a context line (written as the file's own matched line) or a literal new line. */
interface Item {
  ctx: number; // >= 0: this is context, the index of O it stands for; -1: a literal line of N
  t: string;
  noEol?: boolean; // a `\ No newline at end of file` line followed it
}

type Edit = (tree: Tree) => Move | null;

/** A file a move edit carried from one path to another. */
interface Move {
  old: string;
  next: string;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

function checkSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

function mustExist(tree: Tree, p: string): Doc {
  checkSafe(p);
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return parseDoc(t);
}

function mustNotExist(tree: Tree, p: string): void {
  checkSafe(p);
  if (tree.get(p) !== null) throw new Fail('exists', p);
}

/** Section 5: one line equal at `tier`. */
function eqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrim(a) === rtrim(b);
  return btrim(a) === btrim(b);
}

/** The first tier at which O occurs at least once, with all its occurrences there. */
function findTier(lines: string[], o: string[]): { tier: number; occ: number[] } | null {
  const max = STRICT ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    const occ: number[] = [];
    for (let i = 0; i + o.length <= lines.length; i += 1) {
      let ok = true;
      for (let k = 0; k < o.length; k += 1) {
        if (!eqAt(lines[i + k]!, o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) occ.push(i);
    }
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** The lines N writes, given the matched file lines starting at `start` and the tier they matched at. */
function emitN(lines: string[], start: number, o: string[], n: Item[], tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(lines[start]!);
    p = leadWs(o[0]!);
  }
  const out: string[] = [];
  for (const it of n) {
    if (it.ctx >= 0) {
      out.push(lines[start + it.ctx]!);
      continue;
    }
    let t = it.t;
    if (tier === 2 && t !== '' && btrim(t) !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Whether the hunk's last context or `+` line carried a `\ No newline at end of file` marker. */
function endsWithoutBreak(n: Item[]): boolean {
  for (let i = n.length - 1; i >= 0; i -= 1) return n[i]!.noEol === true;
  return false;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------------------------------------------------------------- section 9: JSON edits */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      mustNotExist(tree, p);
      tree.now.set(p, text);
      return null;
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = mustExist(tree, p);
      const crlf = before.br === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(render(before));
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return null;
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const d = mustExist(tree, p);
      if (line < 0 || line > d.lines.length) throw new Fail('no-match', p);
      d.lines.splice(line, 0, ...add);
      tree.now.set(p, render(d));
      return null;
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (blank(l)) continue;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  }
  return edits;
}

/* ---------------------------------------------------------------- section 7: SEARCH/REPLACE */

interface Block {
  path: string;
  old: string[];
  next: string[];
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: Block[] = [];
  let since = 0;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (rtrim(lines[i]!) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const se = i;
    let path: string | null = null;
    for (let k = se - 1; k >= since; k -= 1) {
      const t = lines[k]!;
      if (blank(t)) continue;
      const s = t.trim();
      if (s.startsWith('```')) continue;
      path = s;
      break;
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${se + 1}`);
    let eq = -1;
    let end = -1;
    for (let k = se + 1; k < lines.length; k += 1) {
      const t = rtrim(lines[k]!);
      if (eq < 0) {
        if (t === '=======') eq = k;
        continue;
      }
      if (t === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (eq < 0 || end < 0) throw new Exit2(`error: parse ${se + 1}`);
    blocks.push({ path, old: lines.slice(se + 1, eq), next: lines.slice(eq + 1, end) });
    lastPath = path;
    since = end + 1;
    i = end + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const b of blocks) {
    const p = b.path;
    const o = b.old;
    const n = b.next;
    edits.push((tree) => {
      if (o.length === 0) {
        mustNotExist(tree, p);
        tree.now.set(p, render({ lines: n.slice(), final: n.length > 0, br: '\n' }));
        return null;
      }
      const d = mustExist(tree, p);
      const found = findTier(d.lines, o);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const start = found.occ[0]!;
      const written = emitN(
        d.lines,
        start,
        o,
        n.map((t) => ({ ctx: -1, t })),
        found.tier,
      );
      d.lines.splice(start, o.length, ...written);
      tree.now.set(p, render(d));
      return null;
    });
  }
  return edits;
}

/* ---------------------------------------------------------------- section 8: V4A */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  at: number; // 1-based line of the section header
  moveTo: string | null;
  body: string[];
  chunks: Chunk[];
}

/** Split a chunk's body lines into O (context and `-`) and N (context and `+`). */
function splitBody(body: string[]): { o: string[]; n: Item[] } {
  const o: string[] = [];
  const n: Item[] = [];
  for (const b of body) {
    const ch = b === '' ? ' ' : b[0]!;
    const t = b === '' ? '' : b.slice(1);
    if (ch === ' ') {
      n.push({ ctx: o.length, t });
      o.push(t);
    } else if (ch === '-') {
      o.push(t);
    } else {
      n.push({ ctx: -1, t });
    }
  }
  return { o, n };
}

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!blank(lines[i]!)) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last <= first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const secs: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: Chunk | null = null;

  const closeChunk = (popBlanks: boolean): void => {
    if (chunk === null) return;
    if (popBlanks) while (chunk.body.length > 0 && blank(chunk.body[chunk.body.length - 1]!)) chunk.body.pop();
    if (cur !== null) cur.chunks.push(chunk);
    chunk = null;
  };
  const closeSection = (): void => {
    closeChunk(true);
    if (cur !== null) secs.push(cur);
    cur = null;
  };

  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      closeSection();
      const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : 'upd';
      const path = l.slice(l.indexOf(': ') + 2).trim();
      cur = { kind, path, at: i + 1, moveTo: null, body: [], chunks: [] };
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (l === '') {
        cur.body.push('');
      } else if (l[0] === '+') {
        cur.body.push(l.slice(1));
      } else {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      continue;
    }
    if (cur.kind === 'del') {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.chunks.length === 0 && chunk === null && cur.moveTo === null && l.startsWith('*** Move to: ')) {
      cur.moveTo = l.slice(12).trim();
      continue;
    }
    if (l === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
      chunk.eof = true;
      closeChunk(false);
      continue;
    }
    if (l.startsWith('@@')) {
      closeChunk(false);
      chunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
      chunk.body.push(l);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closeSection();

  for (const s of secs) {
    if (s.kind === 'upd' && s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.at}`);
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const s of secs) {
    if (s.kind === 'add') {
      const p = s.path;
      const body = s.body.slice();
      while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
      edits.push((tree) => {
        mustNotExist(tree, p);
        tree.now.set(p, render({ lines: body, final: body.length > 0, br: '\n' }));
        return null;
      });
      continue;
    }
    if (s.kind === 'del') {
      const p = s.path;
      edits.push((tree) => {
        checkSafe(p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return null;
      });
      continue;
    }
    const p = s.path;
    const moveTo = s.moveTo;
    const chunks = s.chunks;
    edits.push((tree) => {
      const d = mustExist(tree, p);
      if (moveTo !== null) mustNotExist(tree, moveTo);
      let cursor = 0;
      for (const c of chunks) {
        if (c.anchor !== null) {
          let at = -1;
          const max = STRICT ? 0 : 2;
          for (let tier = 0; tier <= max && at < 0; tier += 1) {
            for (let k = cursor; k < d.lines.length; k += 1) {
              if (eqAt(d.lines[k]!, c.anchor, tier)) {
                at = k;
                break;
              }
            }
          }
          if (at < 0) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        const { o, n } = splitBody(c.body);
        if (o.length === 0) {
          const at = c.eof ? d.lines.length : Math.min(cursor, d.lines.length);
          const written = n.map((x) => x.t);
          d.lines.splice(at, 0, ...written);
          cursor = at + written.length;
          continue;
        }
        const max = STRICT ? 0 : 2;
        let best = -1;
        let bestTier = 0;
        for (let tier = 0; tier <= max && best < 0; tier += 1) {
          for (let k = cursor; k + o.length <= d.lines.length; k += 1) {
            let ok = true;
            for (let q = 0; q < o.length; q += 1) {
              if (!eqAt(d.lines[k + q]!, o[q]!, tier)) {
                ok = false;
                break;
              }
            }
            if (!ok) continue;
            if (c.eof && k + o.length !== d.lines.length) continue;
            best = k;
            bestTier = tier;
            break;
          }
        }
        if (best < 0) throw new Fail('no-match', p);
        const written = emitN(d.lines, best, o, n, bestTier);
        d.lines.splice(best, o.length, ...written);
        cursor = best + written.length;
      }
      const out = render(d);
      if (moveTo !== null) {
        tree.now.set(p, null);
        tree.now.set(moveTo, out);
        return { old: p, next: moveTo };
      }
      tree.now.set(p, out);
      return null;
    });
  }
  return edits;
}

/* ---------------------------------------------------------------- section 6: unified diffs */

interface Hunk {
  a: number;
  o: string[];
  n: Item[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function headerPath(raw: string): string {
  const tab = raw.indexOf('\t');
  const t = tab >= 0 ? raw.slice(0, tab) : raw;
  return stripPrefix(t.trim());
}

function parseUnified(lines: string[]): Edit[] {
  const err = (ln: number) => new Exit2(`error: parse ${ln}`);
  const N = lines.length;
  const secs: USection[] = [];
  let cur: USection | null = null;
  const fresh = (): USection => ({ oldPath: null, newPath: null, create: false, del: false, hunks: [] });
  let i = 0;

  while (i < N) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice(11);
      if (!rest.startsWith('a/')) throw err(i + 1);
      const sep = rest.indexOf(' b/');
      if (sep < 0) throw err(i + 1);
      const x = rest.slice(2, sep);
      const y = rest.slice(sep + 3);
      if (x === '' || y === '') throw err(i + 1);
      cur = fresh();
      cur.oldPath = x;
      cur.newPath = y;
      secs.push(cur);
      i += 1;
      continue;
    }
    const pair = l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (pair) {
      if (cur === null || cur.hunks.length > 0) {
        cur = fresh();
        secs.push(cur);
      }
      cur.oldPath = headerPath(l.slice(4));
      cur.newPath = headerPath((lines[i + 1] ?? '').slice(4));
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw err(i + 1);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw err(i + 1);
      const a = Number(m[1]);
      let j = i + 1;
      const body: string[] = [];
      while (j < N) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (!(b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\')) break;
        body.push(b);
        j += 1;
      }
      let pop = 0;
      while (body.length > pop && body[body.length - 1 - pop] === '') pop += 1;
      if (pop > 0) {
        body.length -= pop;
        j -= pop;
      }
      const o: string[] = [];
      const n: Item[] = [];
      let prevNewOrCtx = false;
      for (const b of body) {
        if (b[0] === '\\') {
          // A `\` line refers to the body line before it, and only a context or `+` line counts
          // for the final break (SPEC.md section 6).
          if (prevNewOrCtx && n.length > 0) n[n.length - 1]!.noEol = true;
          prevNewOrCtx = false;
          continue;
        }
        const ch = b === '' ? ' ' : b[0]!;
        const t = b === '' ? '' : b.slice(1);
        if (ch === ' ') {
          n.push({ ctx: o.length, t });
          o.push(t);
          prevNewOrCtx = true;
        } else if (ch === '-') {
          o.push(t);
          prevNewOrCtx = false;
        } else {
          n.push({ ctx: -1, t });
          prevNewOrCtx = true;
        }
      }
      cur.hunks.push({ a, o, n });
      i = j;
      continue;
    }
    if (cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) {
        cur.oldPath = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.newPath = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.del = true;
        i += 1;
        continue;
      }
      if (l.startsWith('--- ')) throw err(i + 2);
    } else if (l.startsWith('--- ')) {
      // Outside a section's header prose is ignored.
    }
    i += 1;
  }

  if (secs.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const s of secs) {
    const isCreate = s.create || s.oldPath === '/dev/null';
    const isDelete = s.del || s.newPath === '/dev/null';
    if (isCreate) {
      const target = s.newPath ?? s.oldPath ?? '';
      edits.push((tree) => {
        mustNotExist(tree, target);
        const out: string[] = [];
        let noEol = false;
        for (const h of s.hunks) {
          for (const it of h.n) {
            if (it.ctx >= 0) continue;
            out.push(it.t);
            noEol = it.noEol === true;
          }
        }
        tree.now.set(target, render({ lines: out, final: out.length > 0 && !noEol, br: '\n' }));
        return null;
      });
      continue;
    }
    if (isDelete) {
      const target = s.oldPath ?? s.newPath ?? '';
      edits.push((tree) => {
        checkSafe(target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
        return null;
      });
      continue;
    }
    const from = s.oldPath ?? s.newPath ?? '';
    const to = s.newPath ?? s.oldPath ?? '';
    const moving = from !== to;
    const hunks = s.hunks;
    edits.push((tree) => {
      const d = mustExist(tree, from);
      if (moving) mustNotExist(tree, to);
      let shift = 0;
      for (const h of hunks) {
        const o = h.o;
        const n = h.n;
        const before = d.lines.length;
        if (o.length === 0) {
          const at = Math.max(0, Math.min(h.a + shift, d.lines.length));
          const written = n.map((x) => x.t);
          d.lines.splice(at, 0, ...written);
          shift += written.length;
          if (at === before) d.final = !endsWithoutBreak(n);
        } else {
          const found = findTier(d.lines, o);
          if (found === null) throw new Fail('no-match', from);
          const want = h.a - 1 + shift;
          let best = found.occ[0]!;
          let bestDist = Math.abs(best - want);
          for (const pos of found.occ) {
            const dist = Math.abs(pos - want);
            if (dist < bestDist) {
              best = pos;
              bestDist = dist;
            }
          }
          const written = emitN(d.lines, best, o, n, found.tier);
          d.lines.splice(best, o.length, ...written);
          shift += written.length - o.length;
          if (best + o.length === before) d.final = !endsWithoutBreak(n);
        }
      }
      const out = render(d);
      if (moving) {
        tree.now.set(from, null);
        tree.now.set(to, out);
        return { old: from, next: to };
      }
      tree.now.set(from, out);
      return null;
    });
  }
  return edits;
}

/* ---------------------------------------------------------------- section 1: the command line */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !STRICT) STRICT = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else if (kind === 'v4a') edits = parseV4A(lines);
    else edits = parseUnified(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv !== null) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  // A move that carried a file away is one `R` line, standing in for the pair's `D` and `A`.
  const renamed = new Map<string, string>(); // new path -> R line
  const dropped = new Set<string>(); // old paths a rename line already accounts for
  for (const mv of moves) {
    const hadOld = tree.original(mv.old) !== null;
    const goneNow = tree.get(mv.old) === null;
    const hadNew = tree.original(mv.next) !== null;
    const thereNow = tree.get(mv.next) !== null;
    if (!(hadOld && goneNow && !hadNew && thereNow)) continue;
    if (mv.old === mv.next) continue;
    renamed.set(mv.next, `R ${mv.old} -> ${mv.next}`);
    dropped.add(mv.old);
  }

  const rows: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (dropped.has(p)) continue;
    const rep = renamed.get(p);
    if (rep !== undefined) {
      rows.push({ key: p, line: rep });
      continue;
    }
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));

  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
