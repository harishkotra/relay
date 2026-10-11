// Runtime line counter for the two implementation files. Reads from disk on
// every call so the number shown in the UI can never drift from the real file.
//
// Comments and blank lines are excluded. The scanner tracks string, template
// literal and comment state character by character so a URL inside a string
// ("https://x") is not mistaken for a line comment.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the TypeScript sources live. Under `tsx` this is the folder holding this
 * file; after `tsc` the compiled copy sits in dist/server while the sources the
 * UI must display stay in server/, so both are probed.
 */
function sourceRoot(): string {
  const candidates = [HERE, join(HERE, '..', '..', 'server'), join(process.cwd(), 'server')];
  return candidates.find((dir) => existsSync(join(dir, 'handrolled.ts'))) ?? HERE;
}

export interface LocReport {
  /** Non-blank, non-comment lines. */
  loc: number;
  totalLines: number;
  commentOnlyLines: number;
  blankLines: number;
}

/** Blank out comment characters, keeping the newline structure intact. */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';

  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1] ?? '';

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      out += ch;
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += '\n';
      } else out += ' ';
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    // Inside a string-like token: only escapes and the closing quote matter.
    const closer = state === 'single' ? "'" : state === 'double' ? '"' : '`';
    if (ch === '\\') {
      out += ch + next;
      i += 2;
      continue;
    }
    if (ch === closer) state = 'code';
    out += ch;
    i += 1;
  }

  return out;
}

export function countLoc(source: string): LocReport {
  const codeLines = stripComments(source).split('\n');
  const raw = source.replace(/\n+$/, '').split('\n');
  let loc = 0;
  for (let i = 0; i < codeLines.length; i += 1) {
    if (codeLines[i]!.trim().length > 0) loc += 1;
  }
  const nonBlankRaw = raw.filter((line) => line.trim().length > 0).length;
  return {
    loc,
    totalLines: raw.length,
    commentOnlyLines: nonBlankRaw - loc,
    blankLines: raw.length - nonBlankRaw,
  };
}

/** Resolve a logical file name ('handrolled') to its absolute source path. */
export function serverFile(name: string): string {
  return normalize(join(sourceRoot(), `${name.replace(/^server\//, '')}.ts`));
}

export async function readServerFile(name: string): Promise<{ path: string; content: string; report: LocReport }> {
  const path = serverFile(name);
  const content = await readFile(path, 'utf8');
  return { path, content, report: countLoc(content) };
}
