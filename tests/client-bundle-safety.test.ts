import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 클라이언트 컴포넌트가 서버 전용 모듈을 끌고 오지 않는다 (2026-10-01).
 *
 * `'use client'` 파일이 (직간접으로) `@/lib/env`·`node:crypto`·`@/server/*` 를 import 하면 그 코드가
 * 브라우저 번들에 실린다. env 검증은 브라우저에서 APP_ENV 를 못 읽어 운영으로 간주하고 비밀값이
 * 없다며 예외를 던진다. 실제로 후원자 닉네임 규칙이 `@/lib/crypto` 를 불러오는 바람에 마이페이지 계정
 * 화면과 결제수단 등록·후원 확인 화면이 브라우저에서 통째로 오류 화면이 됐다.
 */

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm;

function resolveSpec(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
    const p = base + ext;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'generated') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const startsWithDirective = (file: string, d: string) =>
  fs.readFileSync(file, 'utf8').trimStart().startsWith(`'${d}'`) ||
  fs.readFileSync(file, 'utf8').trimStart().startsWith(`"${d}"`);

function forbiddenChain(entry: string): string | null {
  const seen = new Set<string>();
  const stack: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [] }];
  while (stack.length) {
    const { file, chain } = stack.pop()!;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (spec === 'node:crypto' || spec === 'crypto' || spec === 'node:fs' || spec === 'fs') {
        return [...chain, path.relative(ROOT, file), spec].join(' > ');
      }
      const resolved = resolveSpec(spec, file);
      if (!resolved) continue;
      const rel = path.relative(ROOT, resolved);
      if (rel === path.join('src', 'lib', 'env.ts') || rel.startsWith(path.join('src', 'server') + path.sep)) {
        return [...chain, path.relative(ROOT, file), rel].join(' > ');
      }
      // 서버 액션('use server')은 클라이언트에서 참조만 하므로 따라가지 않는다.
      if (seen.has(resolved) || startsWithDirective(resolved, 'use server')) continue;
      seen.add(resolved);
      stack.push({ file: resolved, chain: [...chain, path.relative(ROOT, file)] });
    }
  }
  return null;
}

describe('클라이언트 번들 안전성', () => {
  it("'use client' 파일은 env·node:crypto·서버 모듈을 끌고 오지 않는다", () => {
    const offenders = walk(SRC)
      .filter((f) => startsWithDirective(f, 'use client'))
      .map((f) => forbiddenChain(f))
      .filter((x): x is string => Boolean(x));
    expect(offenders).toEqual([]);
  });
});
