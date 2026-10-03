import type { SourceLanguage } from '@codeclash/shared';

export interface Mutant {
  id: string;
  operator: string;
  description: string;
  line: number;
  original: string;
  mutated: string;
  code: string;
}

/** True for every character that is code, false inside string literals and comments. */
export function codeMask(language: SourceLanguage, source: string): boolean[] {
  const mask = new Array<boolean>(source.length).fill(true);
  const python = language === 'python';
  let i = 0;
  const skip = (from: number, to: number) => {
    for (let k = from; k < to && k < source.length; k += 1) mask[k] = false;
  };
  while (i < source.length) {
    const rest = source.slice(i, i + 3);
    if (python && source[i] === '#') {
      const end = source.indexOf('\n', i);
      skip(i, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end;
    } else if (!python && rest.startsWith('//')) {
      const end = source.indexOf('\n', i);
      skip(i, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end;
    } else if (!python && rest.startsWith('/*')) {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      skip(i, stop);
      i = stop;
    } else if (!python && source[i] === '#' && (i === 0 || source[i - 1] === '\n')) {
      const end = source.indexOf('\n', i);
      skip(i, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end;
    } else if (python && (rest === '"""' || rest === "'''")) {
      const end = source.indexOf(rest, i + 3);
      const stop = end < 0 ? source.length : end + 3;
      skip(i, stop);
      i = stop;
    } else if (source[i] === '"' || source[i] === "'" || (source[i] === '`' && language === 'javascript')) {
      const quote = source[i]!;
      let k = i + 1;
      while (k < source.length && source[k] !== quote && source[k] !== '\n') k += source[k] === '\\' ? 2 : 1;
      skip(i, k + 1);
      i = k + 1;
    } else {
      i += 1;
    }
  }
  return mask;
}

interface Edit { at: number; length: number; replacement: string; operator: string; description: string }

const IDENT = /[A-Za-z0-9_]/;
const OPERAND_BEFORE = /[A-Za-z0-9_)\]]/;
const OPERAND_AFTER = /[A-Za-z0-9_(]/;

function lastNonSpace(source: string, at: number) {
  for (let k = at - 1; k >= 0; k -= 1) if (source[k] !== ' ' && source[k] !== '\t') return source[k]!;
  return '';
}
function nextNonSpace(source: string, at: number) {
  for (let k = at; k < source.length; k += 1) if (source[k] !== ' ' && source[k] !== '\t') return source[k]!;
  return '';
}

/** `vector<int>` and `Map<String, Integer>` are types, not comparisons. */
function insideGeneric(source: string, at: number) {
  const lineStart = source.lastIndexOf('\n', at) + 1;
  const lineEnd = source.indexOf('\n', at);
  const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
  for (const match of line.matchAll(/\b[A-Za-z_][\w:]*<[\w:\s,<>*]*>/g)) {
    const start = lineStart + match.index!;
    if (at >= start && at < start + match[0].length) return true;
  }
  return false;
}

function edits(language: SourceLanguage, source: string, mask: boolean[]): Edit[] {
  const out: Edit[] = [];
  const isCode = (at: number, length: number) => {
    for (let k = at; k < at + length; k += 1) if (!mask[k]) return false;
    return true;
  };
  const scan = (pattern: RegExp, build: (match: RegExpMatchArray) => Omit<Edit, 'at' | 'length'> | null) => {
    for (const match of source.matchAll(pattern)) {
      const at = match.index!;
      if (!isCode(at, match[0].length)) continue;
      const edit = build(match);
      if (edit) out.push({ at, length: match[0].length, ...edit });
    }
  };
  const python = language === 'python';

  const relational: Record<string, string> = {
    '<': '<=', '<=': '<', '>': '>=', '>=': '>', '==': '!=', '!=': '==', '===': '!==', '!==': '===',
  };
  scan(/===|!==|<=|>=|==|!=|<|>/g, (m) => {
    const at = m.index!;
    const before = source[at - 1] ?? '';
    const after = source[at + m[0].length] ?? '';
    if ('<>=-!'.includes(before) || '<>='.includes(after)) return null;
    if (m[0] === '>' && before === '-') return null;
    if (!python && (m[0] === '<' || m[0] === '>') && insideGeneric(source, at)) return null;
    const to = relational[m[0]]!;
    return { replacement: to, operator: 'relational', description: `${m[0]} to ${to}` };
  });

  const arithmetic: Record<string, string> = { '+': '-', '-': '+', '*': '/', '/': '*' };
  scan(/[+\-*/]=?/g, (m) => {
    const at = m.index!;
    const symbol = m[0][0]!;
    const before = source[at - 1] ?? '';
    const after = source[at + 1] ?? '';
    if (before === symbol || after === symbol) return null;
    if (symbol === '-' && after === '>') return null;
    if (m[0].length === 1 && (!OPERAND_BEFORE.test(lastNonSpace(source, at)) || !OPERAND_AFTER.test(nextNonSpace(source, at + 1)))) return null;
    let to = arithmetic[symbol]!;
    if (python && to === '/') to = '//';
    return { replacement: to + m[0].slice(1), operator: 'arithmetic', description: `${m[0]} to ${to}${m[0].slice(1)}` };
  });
  if (python) {
    scan(/\/\//g, () => ({ replacement: '*', operator: 'arithmetic', description: '// to *' }));
  }

  scan(/\d+/g, (m) => {
    const at = m.index!;
    const before = source[at - 1] ?? '';
    const after = source[at + m[0].length] ?? '';
    if (IDENT.test(before) || before === '.' || /[A-Za-z_.xX]/.test(after) && !/[lLuU]/.test(after)) return null;
    if (m[0].length > 1 && m[0].startsWith('0')) return null;
    const value = BigInt(m[0]);
    const up = (value + 1n).toString();
    const edit = { replacement: up, operator: 'literal', description: `${m[0]} to ${up}` };
    if (value === 0n) return edit;
    out.push({ at, length: m[0].length, replacement: (value - 1n).toString(), operator: 'literal', description: `${m[0]} to ${value - 1n}` });
    return edit;
  });

  if (python) {
    scan(/\brange\(([^(),]+)\)/g, (m) => {
      const arg = m[1]!.trim();
      out.push({ at: m.index!, length: m[0].length, replacement: `range(1, ${arg})`, operator: 'range', description: `range(${arg}) to range(1, ${arg})` });
      return { replacement: `range(${arg} - 1)`, operator: 'range', description: `range(${arg}) to range(${arg} - 1)` };
    });
    scan(/\b(and|or)\b/g, (m) => {
      const to = m[0] === 'and' ? 'or' : 'and';
      return { replacement: to, operator: 'logical', description: `${m[0]} to ${to}` };
    });
  } else {
    scan(/&&|\|\|/g, (m) => {
      const to = m[0] === '&&' ? '||' : '&&';
      return { replacement: to, operator: 'logical', description: `${m[0]} to ${to}` };
    });
  }

  scan(/\b(min|max)\s*\(/g, (m) => {
    const to = m[1] === 'min' ? 'max' : 'min';
    return { replacement: m[0].replace(m[1]!, to), operator: 'min-max', description: `${m[1]} to ${to}` };
  });

  scan(/\bbreak\b\s*;?/g, (m) => ({
    replacement: python ? 'pass' : ';',
    operator: 'break',
    description: `remove ${m[0].trim()}`,
  }));

  if (language === 'cpp' || language === 'c') {
    scan(/\blong\s+long\b/g, () => ({ replacement: 'int', operator: 'overflow', description: 'long long to int' }));
  }
  return out;
}

function lineAt(source: string, at: number) {
  const start = source.lastIndexOf('\n', at - 1) + 1;
  const end = source.indexOf('\n', at);
  return { number: source.slice(0, start).split('\n').length, start, end: end < 0 ? source.length : end };
}

/**
 * Up to `max` single-edit mutants of `source`, taking operators in turn so one noisy operator
 * (usually literals) cannot fill the list. Identical results are kept once.
 */
export function generateMutants(language: SourceLanguage, source: string, max = 40): Mutant[] {
  const mask = codeMask(language, source);
  const byOperator = new Map<string, Edit[]>();
  for (const edit of edits(language, source, mask)) {
    const list = byOperator.get(edit.operator) ?? [];
    list.push(edit);
    byOperator.set(edit.operator, list);
  }
  const queues = [...byOperator.values()];
  const seen = new Set<string>([source]);
  const out: Mutant[] = [];
  for (let round = 0; out.length < max && queues.some((q) => q.length > round); round += 1) {
    for (const queue of queues) {
      const edit = queue[round];
      if (!edit || out.length >= max) continue;
      const code = source.slice(0, edit.at) + edit.replacement + source.slice(edit.at + edit.length);
      if (seen.has(code)) continue;
      seen.add(code);
      const line = lineAt(source, edit.at);
      const original = source.slice(line.start, line.end);
      const offset = edit.at - line.start;
      const mutated = original.slice(0, offset) + edit.replacement + original.slice(offset + edit.length);
      out.push({
        id: `m${out.length + 1}`,
        operator: edit.operator,
        description: `line ${line.number}: ${edit.description}`,
        line: line.number,
        original: original.trim(),
        mutated: mutated.trim(),
        code,
      });
    }
  }
  return out;
}
