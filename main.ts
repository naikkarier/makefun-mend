// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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

type Edit = (tree: Tree) => void;

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

// ---------------------------------------------------------------------------
// Files: line-break model (SPEC.md section 3)
// ---------------------------------------------------------------------------

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { br, lines: parts, final };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

interface Occurrence {
  tier: number;
  positions: number[];
}

/** First tier at which O occurs in fileLines, with every position. */
function findOccurrences(fileLines: string[], O: string[], strict: boolean): Occurrence | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const eq =
      t === 0
        ? (a: string, b: string): boolean => a === b
        : t === 1
          ? (a: string, b: string): boolean => trimEndWS(a) === trimEndWS(b)
          : (a: string, b: string): boolean => trimWS(a) === trimWS(b);
    const pos: number[] = [];
    for (let i = 0; i + O.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!eq(fileLines[i + j]!, O[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** First tier at which O occurs at or after `from`, with every such position. */
function findOccurrencesFrom(fileLines: string[], O: string[], from: number, strict: boolean): Occurrence | null {
  const all = findOccurrences(fileLines, O, strict);
  if (all === null) return null;
  const pos = all.positions.filter((p) => p >= from);
  if (pos.length === 0) return null;
  return { tier: all.tier, positions: pos };
}

interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Build the replacement lines for a match at matchPos. Context lines come
 *  from the file's own matched lines; at tier 2 the other lines are
 *  re-indented from O's first line to the file's first matched line. */
function buildNewLines(N: NLine[], fileLines: string[], matchPos: number, O: string[], tier: number): string[] {
  return N.map((nl) => {
    if (nl.ctx) return fileLines[matchPos + nl.oIdx]!;
    if (tier === 2 && O.length > 0) {
      const F = leadWS(fileLines[matchPos]!);
      const P = leadWS(O[0]!);
      if (nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(P)) return F + nl.text.slice(P.length);
    }
    return nl.text;
  });
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

type BodyKind = 'ctx' | 'del' | 'add' | 'slash';
interface BodyLine {
  kind: BodyKind;
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  O: string[];
  N: NLine[];
  slashAfterLastCtxOrAdd: boolean;
  slashAfterLastAdd: boolean;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = parseInt(m[1]!, 10);
  const body: BodyLine[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'del', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'add', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'slash', text: l.slice(1) });
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      N.push({ text: b.text, ctx: true, oIdx: O.length });
      O.push(b.text);
    } else if (b.kind === 'del') {
      O.push(b.text);
    } else if (b.kind === 'add') {
      N.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  const lastCtxOrAdd = (() => {
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === 'ctx' || body[k]!.kind === 'add') return k;
    }
    return -1;
  })();
  const lastAdd = (() => {
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === 'add') return k;
    }
    return -1;
  })();
  const slashAfter = (k: number): boolean => k >= 0 && k + 1 < body.length && body[k + 1]!.kind === 'slash';
  return {
    hunk: {
      a,
      body,
      O,
      N,
      slashAfterLastCtxOrAdd: slashAfter(lastCtxOrAdd),
      slashAfterLastAdd: slashAfter(lastAdd),
    },
    next: j,
  };
}

/** Apply one hunk to a file model; d is the length drift of earlier hunks. */
function applyHunk(f: FileModel, h: Hunk, d: number, strict: boolean, path: string): FileModel {
  if (h.O.length > 0) {
    const occ = findOccurrences(f.lines, h.O, strict);
    if (occ === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = occ.positions[0]!;
    for (const p of occ.positions) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const repl = buildNewLines(h.N, f.lines, best, h.O, occ.tier);
    const lines = [...f.lines.slice(0, best), ...repl, ...f.lines.slice(best + h.O.length)];
    let final = f.final;
    if (best + h.O.length === f.lines.length) {
      const lastIdx = (() => {
        for (let k = h.body.length - 1; k >= 0; k--) {
          if (h.body[k]!.kind === 'ctx' || h.body[k]!.kind === 'add') return k;
        }
        return -1;
      })();
      if (lastIdx >= 0) final = !h.slashAfterLastCtxOrAdd;
    }
    return { br: f.br, lines, final };
  }
  const pos = Math.min(h.a + d, f.lines.length);
  const repl = buildNewLines(h.N, f.lines, pos, h.O, 0);
  const lines = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos)];
  let final = f.final;
  if (pos === f.lines.length) {
    const lastIdx = (() => {
      for (let k = h.body.length - 1; k >= 0; k--) {
        if (h.body[k]!.kind === 'ctx' || h.body[k]!.kind === 'add') return k;
      }
      return -1;
    })();
    if (lastIdx >= 0) final = !h.slashAfterLastCtxOrAdd;
  }
  return { br: f.br, lines, final };
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  phase: 'header' | 'body';
}

function parseUnifiedPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.pairOld ?? s.renameFrom ?? s.oldPath;
  const newP = s.pairNew ?? s.renameTo ?? s.newPath;
  const isCreate = s.create || oldP === null;
  const isDelete = !isCreate && (s.del || newP === null);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let final = false;
      for (const h of s.hunks) {
        for (const b of h.body) if (b.kind === 'add') plus.push(b.text);
      }
      if (plus.length > 0) {
        let lastSlash = false;
        for (let k = s.hunks.length - 1; k >= 0; k--) {
          const h = s.hunks[k]!;
          if (h.body.some((b) => b.kind === 'add')) {
            lastSlash = h.slashAfterLastAdd;
            break;
          }
        }
        final = !lastSlash;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (isMove) {
      const oldPath = oldP!;
      const newPath = newP!;
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      let f = parseFile(cur);
      let d = 0;
      for (const h of s.hunks) {
        f = applyHunk(f, h, d, strict, oldPath);
        d += h.N.length - h.O.length;
      }
      tree.now.set(oldPath, null);
      tree.now.set(newPath, serializeFile(f));
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    let f = parseFile(cur);
    let d = 0;
    for (const h of s.hunks) {
      f = applyHunk(f, h, d, strict, p);
      d += h.N.length - h.O.length;
    }
    tree.now.set(p, serializeFile(f));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let section: Section | null = null;
  const flush = (): void => {
    if (section !== null) edits.push(sectionEdit(section, strict));
    section = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      flush();
      section = {
        oldPath: m[1]!,
        newPath: m[2]!,
        pairOld: null,
        pairNew: null,
        hasPair: false,
        renameFrom: null,
        renameTo: null,
        create: false,
        del: false,
        hunks: [],
        phase: 'header',
      };
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (section !== null && section.phase === 'header' && !section.hasPair) {
        section.pairOld = parseUnifiedPath(line.slice(4));
        section.pairNew = parseUnifiedPath(lines[i + 1]!.slice(4));
        section.hasPair = true;
        i += 2;
        continue;
      }
      flush();
      section = {
        oldPath: null,
        newPath: null,
        pairOld: parseUnifiedPath(line.slice(4)),
        pairNew: parseUnifiedPath(lines[i + 1]!.slice(4)),
        hasPair: true,
        renameFrom: null,
        renameTo: null,
        create: false,
        del: false,
        hunks: [],
        phase: 'header',
      };
      i += 2;
      continue;
    }
    if (section === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (section.phase === 'header') {
      if (line.startsWith('@@')) {
        const { hunk, next } = parseHunk(lines, i);
        section.hunks.push(hunk);
        section.phase = 'body';
        i = next;
        continue;
      }
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) section.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) section.renameTo = line.slice(10).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) section.create = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) section.del = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const { hunk, next } = parseHunk(lines, i);
      section.hunks.push(hunk);
      i = next;
      continue;
    }
    i++;
  }
  flush();
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let si = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        si = j;
        break;
      }
    }
    if (si < 0) break;
    let path: string | null = null;
    for (let j = si - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${si + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = si + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${si + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${si + 1}`);
    const oldLines = lines.slice(si + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = parseFile(cur);
      const occ = findOccurrences(f.lines, oldLines, strict);
      if (occ === null) throw new Fail('no-match', p);
      if (occ.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = occ.positions[0]!;
      const repl = buildNewLines(
        newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })),
        f.lines,
        pos,
        oldLines,
        occ.tier,
      );
      const out = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + oldLines.length)];
      tree.now.set(p, serializeFile({ br: f.br, lines: out, final: f.final }));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aChunkON(chunk: V4aChunk): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of chunk.body) {
    if (b.kind === 'ctx') {
      N.push({ text: b.text, ctx: true, oIdx: O.length });
      O.push(b.text);
    } else if (b.kind === 'del') {
      O.push(b.text);
    } else if (b.kind === 'add') {
      N.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { O, N };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l === '*** Add File:' || l.startsWith('*** Delete File: ') || l === '*** Delete File:' || l.startsWith('*** Update File: ') || l === '*** Update File:';
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l === '*** Add File:') {
      const path = l.slice('*** Add File:'.length).trim();
      const fileLines: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        const x = lines[j]!;
        if (x === '') {
          fileLines.push('');
          j++;
          continue;
        }
        if (x.startsWith('+')) {
          fileLines.push(x.slice(1));
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      const p = path;
      const content = [...fileLines];
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ') || l === '*** Delete File:') {
      const path = l.slice('*** Delete File:'.length).trim();
      let j = i + 1;
      while (j < last && blank(lines[j]!)) j++;
      if (j < last && !isSectionStart(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ') || l === '*** Update File:') {
      const path = l.slice('*** Update File:'.length).trim();
      const updateLine = i;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && (lines[j]!.startsWith('*** Move to: ') || lines[j]! === '*** Move to:')) {
        moveTo = lines[j]!.slice('*** Move to:'.length).trim();
        j++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (j < last) {
        const x = lines[j]!;
        if (isSectionStart(x)) break;
        if (x.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          j++;
          continue;
        }
        if (x.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: x.slice(2).trim() === '' ? null : x.slice(2).trim(), body: [], eof: false };
          j++;
          continue;
        }
        if (x === '' || x[0] === ' ' || x[0] === '-' || x[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) {
              if (x === '') {
                j++;
                continue;
              }
              throw new Exit2(`error: parse ${j + 1}`);
            }
            cur = { anchor: null, body: [], eof: false };
          }
          cur.body.push(x === '' ? { kind: 'ctx', text: '' } : x[0] === ' ' ? { kind: 'ctx', text: x.slice(1) } : x[0] === '-' ? { kind: 'del', text: x.slice(1) } : { kind: 'add', text: x.slice(1) });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (cur !== null) {
        while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.kind === 'ctx' && cur.body[cur.body.length - 1]!.text === '') cur.body.pop();
        chunks.push(cur);
        cur = null;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      const p = path;
      const mv = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const curText = tree.get(p);
        if (curText === null) throw new Fail('missing', p);
        if (mv !== null) {
          if (!safe(mv)) throw new Fail('unsafe', mv);
          if (tree.get(mv) !== null) throw new Fail('exists', mv);
        }
        let f = parseFile(curText);
        let cursor = 0;
        for (const chunk of chs) {
          let at = cursor;
          if (chunk.anchor !== null) {
            let found = -1;
            for (const t of strict ? [0] : [0, 1, 2]) {
              const eq =
                t === 0
                  ? (a: string, b: string): boolean => a === b
                  : t === 1
                    ? (a: string, b: string): boolean => trimEndWS(a) === trimEndWS(b)
                    : (a: string, b: string): boolean => trimWS(a) === trimWS(b);
              for (let k = cursor; k < f.lines.length; k++) {
                if (eq(f.lines[k]!, chunk.anchor)) {
                  found = k;
                  break;
                }
              }
              if (found >= 0) break;
            }
            if (found < 0) throw new Fail('no-match', p);
            at = found + 1;
          }
          const { O, N } = v4aChunkON(chunk);
          if (O.length > 0) {
            const occ = findOccurrencesFrom(f.lines, O, at, strict);
            if (occ === null) throw new Fail('no-match', p);
            let pos = occ.positions[0]!;
            if (chunk.eof) {
              const ends = occ.positions.filter((q) => q + O.length === f.lines.length);
              if (ends.length === 0) throw new Fail('no-match', p);
              pos = ends[0]!;
            }
            const repl = buildNewLines(N, f.lines, pos, O, occ.tier);
            const out = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + O.length)];
            f = { br: f.br, lines: out, final: f.final };
            cursor = pos + repl.length;
          } else {
            const ins = chunk.eof ? f.lines.length : at;
            const repl = buildNewLines(N, f.lines, ins, O, 0);
            const out = [...f.lines.slice(0, ins), ...repl, ...f.lines.slice(ins)];
            f = { br: f.br, lines: out, final: f.final };
            cursor = ins + repl.length;
          }
        }
        const text = serializeFile(f);
        if (mv !== null) {
          tree.now.set(p, null);
          tree.now.set(mv, text);
          tree.moves.push([p, mv]);
        } else {
          tree.now.set(p, text);
        }
      });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Running (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.delete(oldP);
      rows.delete(newP);
      rows.set(newP, `R ${oldP} -> ${newP}`);
    }
  }
  const out = [...rows.entries()]
    .sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
    .map(([, v]) => v);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
