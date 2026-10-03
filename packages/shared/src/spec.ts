/**
 * Input specs: a few lines that describe a problem's input so tests can be validated and generated.
 *
 *   t int 1..10^4
 *   repeat t:
 *     n int 1..2*10^5, k int 0..n
 *     a int[n] -10^9..10^9
 *     s str[1..n] a-z
 *     lines n-1: u int 1..n, v int 1..n
 *   sum n <= 2*10^5
 *
 * One spec line is one input line, except `lines COUNT:` (COUNT lines with the same fields) and
 * `repeat COUNT:` (the indented block below it, COUNT times). Bounds may use earlier names.
 */

export type Expr =
  | { kind: 'num'; value: bigint }
  | { kind: 'name'; name: string }
  | { kind: 'op'; op: '+' | '-' | '*' | '^'; left: Expr; right: Expr }
  | { kind: 'neg'; arg: Expr };

export type Field =
  | { name: string; type: 'int'; lo: Expr; hi: Expr }
  | { name: string; type: 'ints'; len: Expr; lo: Expr; hi: Expr }
  | { name: string; type: 'str'; lenLo: Expr; lenHi: Expr; alphabet: string };

export type SpecNode =
  | { type: 'line'; fields: Field[] }
  | { type: 'lines'; count: Expr; fields: Field[] }
  | { type: 'repeat'; count: Expr; body: SpecNode[] };

export interface InputSpec {
  nodes: SpecNode[];
  sums: { name: string; max: Expr }[];
}

export class SpecError extends Error {}

// ---------- expressions ----------

function tokenizeExpr(text: string) {
  const tokens = text.replace(/\s+/g, '').match(/\d+(?:e\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*^]/g) ?? [];
  if (tokens.join('') !== text.replace(/\s+/g, '')) throw new SpecError(`cannot read bound "${text}"`);
  return tokens;
}

function parseNumber(token: string): bigint {
  const [mantissa, exponent] = token.split('e');
  return BigInt(mantissa!) * 10n ** BigInt(exponent ?? '0');
}

export function parseExpr(text: string): Expr {
  const tokens = tokenizeExpr(text);
  let at = 0;
  const atom = (): Expr => {
    const token = tokens[at++];
    if (token === undefined) throw new SpecError(`bound "${text}" ends early`);
    if (/^\d/.test(token)) return { kind: 'num', value: parseNumber(token) };
    if (/^[A-Za-z_]/.test(token)) return { kind: 'name', name: token };
    throw new SpecError(`unexpected "${token}" in "${text}"`);
  };
  const power = (): Expr => {
    const base = atom();
    if (tokens[at] === '^') { at += 1; return { kind: 'op', op: '^', left: base, right: atom() }; }
    return base;
  };
  const unary = (): Expr => {
    if (tokens[at] === '-') { at += 1; return { kind: 'neg', arg: unary() }; }
    return power();
  };
  const term = (): Expr => {
    let left = unary();
    while (tokens[at] === '*') { at += 1; left = { kind: 'op', op: '*', left, right: unary() }; }
    return left;
  };
  let expr = term();
  while (tokens[at] === '+' || tokens[at] === '-') {
    const op = tokens[at++] as '+' | '-';
    expr = { kind: 'op', op, left: expr, right: term() };
  }
  if (at !== tokens.length) throw new SpecError(`cannot read bound "${text}"`);
  return expr;
}

export type Env = Map<string, bigint>;

export function evalExpr(expr: Expr, env: Env): bigint {
  switch (expr.kind) {
    case 'num': return expr.value;
    case 'neg': return -evalExpr(expr.arg, env);
    case 'name': {
      const value = env.get(expr.name);
      if (value === undefined) throw new SpecError(`"${expr.name}" is used before it is read`);
      return value;
    }
    case 'op': {
      const left = evalExpr(expr.left, env);
      const right = evalExpr(expr.right, env);
      if (expr.op === '+') return left + right;
      if (expr.op === '-') return left - right;
      if (expr.op === '*') return left * right;
      return left ** right;
    }
  }
}

function namesIn(expr: Expr, into: Set<string>) {
  if (expr.kind === 'name') into.add(expr.name);
  else if (expr.kind === 'neg') namesIn(expr.arg, into);
  else if (expr.kind === 'op') { namesIn(expr.left, into); namesIn(expr.right, into); }
  return into;
}

// ---------- parsing ----------

function expandAlphabet(text: string) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i + 1] === '-' && i + 2 < text.length) {
      for (let c = text.charCodeAt(i); c <= text.charCodeAt(i + 2); c += 1) out += String.fromCharCode(c);
      i += 2;
    } else out += text[i];
  }
  return [...new Set(out)].join('');
}

function parseRange(text: string): [Expr, Expr] {
  const parts = text.split('..');
  if (parts.length !== 2) throw new SpecError(`expected LO..HI, got "${text}"`);
  return [parseExpr(parts[0]!), parseExpr(parts[1]!)];
}

function parseField(text: string): Field {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+(int|str)(?:\[([^\]]+)\])?\s+(.+)$/.exec(text.trim());
  if (!match) throw new SpecError(`cannot read field "${text.trim()}"`);
  const [, name, type, size, rest] = match;
  if (type === 'int') {
    const [lo, hi] = parseRange(rest!.trim());
    return size ? { name: name!, type: 'ints', len: parseExpr(size), lo, hi } : { name: name!, type: 'int', lo, hi };
  }
  if (!size) throw new SpecError(`string "${name}" needs a length, as str[1..n]`);
  const [lenLo, lenHi] = size.includes('..') ? parseRange(size) : [parseExpr(size), parseExpr(size)];
  const alphabet = expandAlphabet(rest!.trim());
  if (!alphabet) throw new SpecError(`string "${name}" needs an alphabet`);
  return { name: name!, type: 'str', lenLo, lenHi, alphabet };
}

function parseFields(text: string) {
  return text.split(',').map(parseField);
}

export function parseSpec(text: string): InputSpec {
  const raw = text.replace(/\r\n/g, '\n').split('\n')
    .map((line, index) => ({ index: index + 1, indent: line.length - line.trimStart().length, body: line.replace(/#.*$/, '').trim() }))
    .filter((line) => line.body !== '');
  const sums: InputSpec['sums'] = [];
  let at = 0;
  const block = (indent: number): SpecNode[] => {
    const nodes: SpecNode[] = [];
    while (at < raw.length && raw[at]!.indent >= indent) {
      const line = raw[at]!;
      if (line.indent > indent && nodes.length === 0) throw new SpecError(`line ${line.index}: unexpected indent`);
      if (line.indent > indent) throw new SpecError(`line ${line.index}: unexpected indent`);
      at += 1;
      try {
        const sum = /^sum\s+([A-Za-z_][A-Za-z0-9_]*)\s*<=\s*(.+)$/.exec(line.body);
        if (sum) { sums.push({ name: sum[1]!, max: parseExpr(sum[2]!) }); continue; }
        const repeat = /^repeat\s+(.+):$/.exec(line.body);
        if (repeat) {
          const childIndent = raw[at]?.indent ?? 0;
          if (childIndent <= indent) throw new SpecError('repeat needs an indented block');
          nodes.push({ type: 'repeat', count: parseExpr(repeat[1]!), body: block(childIndent) });
          continue;
        }
        const lines = /^lines\s+([^:]+):\s*(.+)$/.exec(line.body);
        if (lines) { nodes.push({ type: 'lines', count: parseExpr(lines[1]!), fields: parseFields(lines[2]!) }); continue; }
        nodes.push({ type: 'line', fields: parseFields(line.body) });
      } catch (error) {
        if (error instanceof SpecError && !error.message.startsWith('line ')) throw new SpecError(`line ${line.index}: ${error.message}`);
        throw error;
      }
    }
    return nodes;
  };
  const nodes = block(raw[0]?.indent ?? 0);
  if (nodes.length === 0) throw new SpecError('the spec is empty');
  return { nodes, sums };
}

// ---------- validation ----------

export type Validation = { ok: true } | { ok: false; error: string };

export type Observed =
  | { kind: 'int'; name: string; value: bigint; lo: bigint; hi: bigint }
  | { kind: 'ints'; name: string; values: bigint[]; lo: bigint; hi: bigint }
  | { kind: 'str'; name: string; length: number; lo: bigint };

export function validateInput(spec: InputSpec, input: string, observe?: (seen: Observed) => void): Validation {
  const lines = input.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  let row = 0;
  const env: Env = new Map();
  const totals = new Map<string, bigint>();
  const fail = (message: string): Validation => ({ ok: false, error: `line ${row + 1}: ${message}` });

  const readLine = (fields: Field[]): Validation => {
    if (row >= lines.length) return fail('input ends early');
    const tokens = lines[row]!.trim() === '' ? [] : lines[row]!.trim().split(/\s+/);
    let t = 0;
    for (const field of fields) {
      if (field.type === 'int' || field.type === 'ints') {
        const count = field.type === 'int' ? 1n : evalExpr(field.len, env);
        if (count < 0n || count > 10_000_000n) return fail(`${field.name} has an impossible length ${count}`);
        const lo = evalExpr(field.lo, env);
        const hi = evalExpr(field.hi, env);
        const values: bigint[] = [];
        for (let k = 0n; k < count; k += 1n) {
          const token = tokens[t++];
          if (token === undefined) return fail(`expected ${field.name}`);
          if (!/^-?\d+$/.test(token)) return fail(`${field.name} must be an integer, got "${token}"`);
          const value = BigInt(token);
          if (value < lo || value > hi) return fail(`${field.name} = ${value} is outside ${lo}..${hi}`);
          if (observe) values.push(value);
          if (field.type === 'int') {
            env.set(field.name, value);
            totals.set(field.name, (totals.get(field.name) ?? 0n) + value);
          }
        }
        if (observe) {
          observe(field.type === 'int'
            ? { kind: 'int', name: field.name, value: values[0]!, lo, hi }
            : { kind: 'ints', name: field.name, values, lo, hi });
        }
      } else {
        const token = tokens[t++];
        if (token === undefined) return fail(`expected ${field.name}`);
        const lo = evalExpr(field.lenLo, env);
        const hi = evalExpr(field.lenHi, env);
        if (BigInt(token.length) < lo || BigInt(token.length) > hi) return fail(`${field.name} has length ${token.length}, outside ${lo}..${hi}`);
        const bad = [...token].find((c) => !field.alphabet.includes(c));
        if (bad !== undefined) return fail(`${field.name} contains "${bad}"`);
        observe?.({ kind: 'str', name: field.name, length: token.length, lo });
        env.set(field.name, BigInt(token.length));
      }
    }
    if (t < tokens.length) return fail(`unexpected "${tokens[t]}" at the end of the line`);
    row += 1;
    return { ok: true };
  };

  const walk = (nodes: SpecNode[]): Validation => {
    for (const node of nodes) {
      if (node.type === 'line') {
        const result = readLine(node.fields);
        if (!result.ok) return result;
      } else {
        const count = evalExpr(node.count, env);
        if (count < 0n || count > 1_000_000n) return fail(`impossible count ${count}`);
        for (let k = 0n; k < count; k += 1n) {
          const result = node.type === 'lines' ? readLine(node.fields) : walk(node.body);
          if (!result.ok) return result;
        }
      }
    }
    return { ok: true };
  };

  try {
    const walked = walk(spec.nodes);
    if (!walked.ok) return walked;
    while (row < lines.length && lines[row]!.trim() === '') row += 1;
    if (row < lines.length) return fail('extra input after the last expected line');
    for (const sum of spec.sums) {
      const total = totals.get(sum.name) ?? 0n;
      const max = evalExpr(sum.max, env);
      if (total > max) return { ok: false, error: `sum of ${sum.name} is ${total}, above ${max}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------- generation ----------

export interface Rng { next(): number }

export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

function randomBig(rng: Rng, lo: bigint, hi: bigint) {
  if (hi <= lo) return lo;
  const span = hi - lo + 1n;
  const draw = (BigInt(Math.floor(rng.next() * 2 ** 32)) << 32n) | BigInt(Math.floor(rng.next() * 2 ** 32));
  return lo + (draw % span);
}

export type SizeMode = 'min' | 'small' | 'max' | 'one';
export type ValueMode = 'random' | 'few' | 'min' | 'max' | 'equal' | 'zero' | 'negative';
export type Order = 'none' | 'sorted' | 'reverse';

export interface GenPolicy { size: SizeMode; values: ValueMode; order: Order }

/** Names whose value decides how much input follows: lengths, line counts, repeat counts. */
export function sizeNames(spec: InputSpec) {
  const names = new Set<string>();
  const visit = (nodes: SpecNode[]) => {
    for (const node of nodes) {
      if (node.type !== 'line') namesIn(node.count, names);
      if (node.type === 'repeat') visit(node.body);
      else for (const field of node.fields) {
        if (field.type === 'ints') namesIn(field.len, names);
        if (field.type === 'str') { namesIn(field.lenLo, names); namesIn(field.lenHi, names); }
      }
    }
  };
  visit(spec.nodes);
  return names;
}

/** Sum limits that depend on other names are left to the validator. */
function sumLimit(max: Expr) {
  try {
    return evalExpr(max, new Map());
  } catch {
    return 10n ** 18n;
  }
}

/** A repeat count can be no larger than a sum limit on a positive field inside its block. */
function repeatCaps(spec: InputSpec) {
  const caps = new Map<string, bigint>();
  const fieldsIn = (nodes: SpecNode[]): string[] =>
    nodes.flatMap((node) => (node.type === 'repeat' ? fieldsIn(node.body) : node.fields.map((f) => f.name)));
  const visit = (nodes: SpecNode[]) => {
    for (const node of nodes) {
      if (node.type !== 'repeat') continue;
      visit(node.body);
      if (node.count.kind !== 'name') continue;
      const names = new Set(fieldsIn(node.body));
      for (const sum of spec.sums) {
        if (!names.has(sum.name)) continue;
        const max = sumLimit(sum.max);
        const current = caps.get(node.count.name);
        if (current === undefined || max < current) caps.set(node.count.name, max);
      }
    }
  };
  visit(spec.nodes);
  return caps;
}

function pickSize(lo: bigint, hi: bigint, mode: SizeMode, rng: Rng, cap: bigint) {
  const top = hi < cap ? hi : cap;
  if (top < lo) return null;
  if (mode === 'min') return lo;
  if (mode === 'one') return lo <= 1n && 1n <= top ? 1n : lo;
  if (mode === 'max') return top;
  const smallTop = lo + 7n < top ? lo + 7n : top;
  return randomBig(rng, lo, smallTop);
}

interface Shared { equal?: bigint; hit?: boolean }

function pickValue(lo: bigint, hi: bigint, mode: ValueMode, rng: Rng, shared: Shared) {
  if (hi < lo) return null;
  switch (mode) {
    case 'min': return lo;
    case 'max': return hi;
    case 'zero':
      if (lo <= 0n && 0n <= hi) { shared.hit = true; return 0n; }
      return randomBig(rng, lo, hi);
    case 'negative':
      if (lo < 0n) { shared.hit = true; return randomBig(rng, lo, hi < -1n ? hi : -1n); }
      return randomBig(rng, lo, hi);
    case 'equal':
      shared.equal ??= randomBig(rng, lo, lo + 9n < hi ? lo + 9n : hi);
      return shared.equal >= lo && shared.equal <= hi ? shared.equal : lo;
    case 'few': return randomBig(rng, lo, lo + 4n < hi ? lo + 4n : hi);
    default: return randomBig(rng, lo, hi);
  }
}

function sortBig(values: bigint[], order: Order) {
  if (order === 'none') return values;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return order === 'sorted' ? sorted : sorted.reverse();
}

const MAX_BYTES = 1_000_000;

/** One input under `policy`, or null when the policy cannot produce a valid one. */
export function generateInput(spec: InputSpec, policy: GenPolicy, rng: Rng, sizeCap = 10n ** 6n): string | null {
  const sizes = sizeNames(spec);
  const env: Env = new Map();
  const out: string[] = [];
  const shared: Shared = {};
  const sumLeft = new Map(spec.sums.map((s) => [s.name, sumLimit(s.max)] as const));
  const sumOf = (name: string) => spec.sums.find((s) => s.name === name);
  const countCaps = repeatCaps(spec);
  let iterationsLeft = 1n;
  let bytes = 0;

  const line = (fields: Field[]): boolean => {
    const tokens: string[] = [];
    for (const field of fields) {
      const lo = field.type === 'str' ? evalExpr(field.lenLo, env) : evalExpr(field.lo, env);
      const hi = field.type === 'str' ? evalExpr(field.lenHi, env) : evalExpr(field.hi, env);
      if (field.type === 'int') {
        let value: bigint | null;
        if (sizes.has(field.name)) {
          let top = hi;
          const cap = countCaps.get(field.name);
          if (cap !== undefined && cap < top) top = cap;
          if (sumOf(field.name)) {
            const reserve = (iterationsLeft - 1n) * (lo > 0n ? lo : 0n);
            const left = (sumLeft.get(field.name) ?? hi) - reserve;
            if (left < top) top = left;
          }
          value = pickSize(lo, top, policy.size, rng, sizeCap);
        } else value = pickValue(lo, hi, policy.values, rng, shared);
        if (value === null) return false;
        if (sumOf(field.name)) sumLeft.set(field.name, (sumLeft.get(field.name) ?? 0n) - value);
        env.set(field.name, value);
        tokens.push(String(value));
      } else if (field.type === 'ints') {
        const count = evalExpr(field.len, env);
        if (count < 0n || count > 10n ** 7n) return false;
        const values: bigint[] = [];
        let estimate = bytes;
        for (let k = 0n; k < count; k += 1n) {
          const value = pickValue(lo, hi, policy.values, rng, shared);
          if (value === null) return false;
          estimate += String(value).length + 1;
          if (estimate > MAX_BYTES) return false;
          values.push(value);
        }
        tokens.push(...sortBig(values, policy.order).map(String));
      } else {
        const length = pickSize(lo, hi, policy.size === 'min' || policy.size === 'one' ? 'min' : policy.size, rng, sizeCap);
        if (length === null || length > BigInt(MAX_BYTES)) return false;
        const alphabet = policy.values === 'equal' || policy.values === 'min' ? field.alphabet[0]! : policy.values === 'max' ? field.alphabet.at(-1)! : field.alphabet;
        let text = '';
        for (let k = 0; k < Number(length); k += 1) text += alphabet[Math.floor(rng.next() * alphabet.length)];
        env.set(field.name, length);
        tokens.push(policy.order === 'none' ? text : [...text].sort().join(''));
      }
    }
    const text = tokens.join(' ');
    bytes += text.length + 1;
    out.push(text);
    return bytes <= MAX_BYTES;
  };

  const walk = (nodes: SpecNode[]): boolean => {
    for (const node of nodes) {
      if (node.type === 'line') { if (!line(node.fields)) return false; continue; }
      const count = evalExpr(node.count, env);
      if (count < 0n || count > 10n ** 6n) return false;
      const outer = iterationsLeft;
      for (let k = 0n; k < count; k += 1n) {
        if (node.type === 'repeat') iterationsLeft = count - k;
        if (node.type === 'lines' ? !line(node.fields) : !walk(node.body)) return false;
      }
      iterationsLeft = outer;
    }
    return true;
  };

  try {
    if (!walk(spec.nodes)) return null;
  } catch {
    return null;
  }
  if ((policy.values === 'zero' || policy.values === 'negative') && !shared.hit) return null;
  const text = `${out.join('\n')}\n`;
  return text.length > MAX_BYTES ? null : text;
}

/** Validated or nothing: generation can still step outside a dependent bound. */
function generated(spec: InputSpec, policy: GenPolicy, rng: Rng, sizeCap?: bigint, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const input = generateInput(spec, policy, rng, sizeCap);
    if (input !== null && validateInput(spec, input).ok) return input;
  }
  return null;
}

export function randomInput(spec: InputSpec, rng: Rng): string | null {
  return generated(spec, { size: 'small', values: rng.next() < 0.5 ? 'few' : 'random', order: 'none' }, rng);
}

/** The largest valid input under 1 MB, found by halving the size cap until it fits. */
export function maxScaleInput(spec: InputSpec, rng: Rng): string | null {
  for (let cap = 10n ** 6n; cap >= 1n; cap /= 2n) {
    const input = generated(spec, { size: 'max', values: 'random', order: 'none' }, rng, cap, 2);
    if (input !== null) return input;
  }
  return null;
}

export const BOUNDARY_CLASSES = ['min', 'single', 'max-values', 'all-equal', 'sorted', 'reverse', 'zeros', 'negatives'] as const;
export type BoundaryClass = (typeof BOUNDARY_CLASSES)[number];

const BOUNDARY_POLICY: Record<BoundaryClass, GenPolicy> = {
  min: { size: 'min', values: 'min', order: 'none' },
  single: { size: 'one', values: 'random', order: 'none' },
  'max-values': { size: 'small', values: 'max', order: 'none' },
  'all-equal': { size: 'small', values: 'equal', order: 'none' },
  sorted: { size: 'small', values: 'random', order: 'sorted' },
  reverse: { size: 'small', values: 'random', order: 'reverse' },
  zeros: { size: 'small', values: 'zero', order: 'none' },
  negatives: { size: 'small', values: 'negative', order: 'none' },
};

/** One input per boundary class that the spec allows. Duplicates are dropped. */
export function boundaryInputs(spec: InputSpec, rng: Rng): { kind: BoundaryClass; input: string }[] {
  const seen = new Set<string>();
  const out: { kind: BoundaryClass; input: string }[] = [];
  for (const kind of BOUNDARY_CLASSES) {
    let input: string | null = null;
    for (let attempt = 0; attempt < 6 && input === null; attempt += 1) {
      const candidate = generated(spec, BOUNDARY_POLICY[kind], rng);
      if (candidate === null) break;
      if (inputClasses(spec, candidate).has(kind)) input = candidate;
    }
    if (input === null || seen.has(input)) continue;
    seen.add(input);
    out.push({ kind, input });
  }
  return out;
}

/** Which boundary classes a valid input exhibits, read from its values. Empty when it does not validate. */
export function inputClasses(spec: InputSpec, input: string): Set<BoundaryClass> {
  const sizes = sizeNames(spec);
  const found = new Set<BoundaryClass>();
  let allMin = true;
  const nonDecreasing = (v: bigint[]) => v.every((x, i) => i === 0 || v[i - 1]! <= x);
  const result = validateInput(spec, input, (seen) => {
    if (seen.kind === 'str') {
      if (BigInt(seen.length) !== seen.lo) allMin = false;
      if (seen.length === 1) found.add('single');
      return;
    }
    const values = seen.kind === 'int' ? [seen.value] : seen.values;
    if (seen.kind === 'int' && sizes.has(seen.name)) {
      if (seen.value !== seen.lo) allMin = false;
      if (seen.value === 1n) found.add('single');
      return;
    }
    if (values.some((v) => v !== seen.lo)) allMin = false;
    if (values.some((v) => v === seen.hi)) found.add('max-values');
    if (values.some((v) => v === 0n)) found.add('zeros');
    if (values.some((v) => v < 0n)) found.add('negatives');
    if (seen.kind === 'ints' && values.length >= 2) {
      if (values.every((v) => v === values[0])) found.add('all-equal');
      else if (values.length >= 3 && nonDecreasing(values)) found.add('sorted');
      else if (values.length >= 3 && nonDecreasing([...values].reverse())) found.add('reverse');
    }
  });
  if (!result.ok) return new Set();
  if (allMin) found.add('min');
  return found;
}

/** Total count of integers and string characters: a rough size for "is this a big test". */
export function inputSize(input: string) {
  return input.split(/\s+/).filter(Boolean).reduce((sum, token) => sum + (/^-?\d+$/.test(token) ? 1 : token.length), 0);
}

// ---------- drafting from a statement ----------

function cleanMath(text: string) {
  return text
    .replace(/\$\$\$/g, ' ')
    .replace(/\\(?:le|leq)\b/g, '≤')
    .replace(/<=/g, '≤')
    .replace(/\\(?:cdot|times)\b|·|×|⋅/g, '*')
    .replace(/\\,|\\;|\\!/g, '')
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    .replace(/\^\{([^}]*)\}/g, '^$1')
    .replace(/_\{([^}]*)\}/g, '_$1')
    .replace(/[{}]/g, '');
}

export interface Bound { lo: string; hi: string; indexed: boolean }

const NUM = String.raw`-?\s*\d+(?:\s*\*\s*\d+)?(?:\s*\^\s*\d+)?`;

/** Pulls `lo ≤ x ≤ hi` constraints out of a statement. `a_i` becomes an indexed `a`; `|s|` stays `|s|`. */
export function readConstraints(statement: string): Map<string, Bound> {
  const text = cleanMath(statement);
  const one = String.raw`\|?[A-Za-z](?:_[A-Za-z0-9]+)?\|?`;
  const names = String.raw`(?:${one})(?:\s*,\s*${one})*`;
  const pattern = new RegExp(`(${NUM})\\s*≤\\s*(${names})\\s*≤\\s*(${NUM}|[A-Za-z]\\b)`, 'g');
  /** `1 ≤ l_i ≤ r_i ≤ 10^9`: the second name is bounded below by the first. */
  const chain = new RegExp(`(${NUM})\\s*≤\\s*(${one})\\s*≤\\s*(${one})\\s*≤\\s*(${NUM})`, 'g');
  const read = (raw: string) => {
    const trimmed = raw.trim();
    return { name: trimmed.replace(/_[A-Za-z0-9]+(\|?)$/, '$1'), indexed: /_[A-Za-z0-9]+\|?$/.test(trimmed) };
  };
  const hits: { at: number; name: string; bound: Bound }[] = [];
  const chained = new Set<number>();
  for (const match of text.matchAll(chain)) {
    const lo = match[1]!.replace(/\s+/g, '');
    const hi = match[4]!.replace(/\s+/g, '');
    const first = read(match[2]!);
    const second = read(match[3]!);
    hits.push({ at: match.index!, name: first.name, bound: { lo, hi, indexed: first.indexed } });
    hits.push({ at: match.index! + 1, name: second.name, bound: { lo: first.name, hi, indexed: second.indexed } });
    chained.add(match.index!);
  }
  for (const match of text.matchAll(pattern)) {
    if (chained.has(match.index!)) continue;
    const lo = match[1]!.replace(/\s+/g, '');
    const hi = match[3]!.replace(/\s+/g, '');
    match[2]!.split(',').forEach((raw, k) => {
      const { name, indexed } = read(raw);
      hits.push({ at: match.index! + k / 100, name, bound: { lo, hi, indexed } });
    });
  }
  const found = new Map<string, Bound>();
  for (const hit of hits.sort((a, b) => a.at - b.at)) if (!found.has(hit.name)) found.set(hit.name, hit.bound);
  return found;
}

function readSumLimit(statement: string) {
  const text = cleanMath(statement);
  const match = new RegExp(`sum of (?:the values of )?([a-z])\\b[^.]*?(?:does not exceed|not exceed|at most|≤)\\s*(${NUM})`, 'i').exec(text);
  return match ? { name: match[1]!, max: match[2]!.replace(/\s+/g, '') } : null;
}

function alphabetOf(tokens: string[]) {
  const chars = new Set(tokens.join(''));
  const all = [...chars];
  if (all.every((c) => c >= 'a' && c <= 'z')) return 'a-z';
  if (all.every((c) => c >= 'A' && c <= 'Z')) return 'A-Z';
  if (all.every((c) => c === '0' || c === '1')) return '01';
  if (all.every((c) => /[a-zA-Z]/.test(c))) return 'a-zA-Z';
  if (all.every((c) => /[a-z0-9]/.test(c))) return 'a-z0-9';
  return [...new Set(all)].sort().join('').replace(/[-,#\s]/g, '');
}

/**
 * Guesses a spec from the statement constraints and the shape of the test inputs. The guess is
 * returned only if every given input validates against it, so a wrong guess costs nothing.
 */
function inferBlock(block: string[][], bounds: Map<string, Bound>, alphabet: string, exclude: Set<string>): string[] | null {
  const range = (name: string) => {
    const bound = bounds.get(name);
    return bound ? `${bound.lo}..${bound.hi}` : null;
  };
  const scalars = [...bounds.entries()].filter(([name, b]) => !b.indexed && /^[A-Za-z]$/.test(name) && !exclude.has(name)).map(([name]) => name);
  const arrays = [...bounds.entries()].filter(([name, b]) => b.indexed && /^[A-Za-z]$/.test(name)).map(([name]) => name);
  const used = new Set<string>();
  const known = new Map<string, number>();
  const out: string[] = [];
  const isInt = (token: string) => /^-?\d+$/.test(token);

  let i = 0;
  if (block[0]?.every(isInt)) {
    const fields: string[] = [];
    for (const token of block[0]) {
      const name = scalars.find((s) => !used.has(s));
      const r = name ? range(name) : null;
      if (!name || !r) return null;
      used.add(name);
      known.set(name, Number(token));
      fields.push(`${name} int ${r}`);
    }
    out.push(fields.join(', '));
    i = 1;
  }
  while (i < block.length) {
    const tokens = block[i]!;
    const numeric = tokens.every(isInt);
    const sizeName = [...known.entries()].find(([, value]) => value === tokens.length)?.[0];
    if (numeric && sizeName && arrays.some((a) => !used.has(a))) {
      const array = arrays.find((a) => !used.has(a));
      const r = array ? range(array) : null;
      if (!array || !r) return null;
      used.add(array);
      out.push(`${array} int[${sizeName}] ${r}`);
      i += 1;
      continue;
    }
    const sizedBy = [...known.entries()].find(([, value]) => value === tokens[0]!.length && value > 1)?.[0];
    const digitString = numeric && tokens.length === 1 && sizedBy !== undefined;
    if ((!numeric || digitString) && tokens.length === 1) {
      const lengthKey = [...bounds.keys()].find((key) => key.startsWith('|') && !used.has(key));
      const name = lengthKey?.replace(/\|/g, '') ?? 's';
      const sized = sizedBy ?? (known.has('n') ? 'n' : null);
      const length = lengthKey ? bounds.get(lengthKey)! : sized ? { lo: sized, hi: sized } : null;
      if (!length) return null;
      if (lengthKey) used.add(lengthKey);
      out.push(`${name} str[${length.lo}..${length.hi}] ${digitString ? '0-9' : alphabet}`);
      i += 1;
      continue;
    }
    if (numeric) {
      const rest = block.length - i;
      const exact = [...known.entries()].find(([, value]) => value === rest)?.[0];
      const tree = [...known.entries()].find(([, value]) => value - 1 === rest)?.[0];
      if (!exact && !tree) return null;
      const count = exact ?? `${tree}-1`;
      const indexed = [...bounds.entries()].filter(([name, b]) => b.indexed && /^[A-Za-z]$/.test(name) && !used.has(name) && !known.has(name)).map(([name]) => name);
      const names = indexed.length >= tokens.length ? indexed.slice(0, tokens.length) : ['u', 'v', 'w', 'x', 'y', 'z'].slice(0, tokens.length);
      const fields = names.map((name) => `${name} int ${range(name) ?? (known.has('n') ? '1..n' : '')}`);
      if (fields.some((f) => f.endsWith('int '))) return null;
      out.push(`lines ${count}: ${fields.join(', ')}`);
      return out;
    }
    return null;
  }
  return out;
}

/**
 * Guesses a spec from the statement constraints and the shape of the test inputs. The guess is
 * returned only if every given input validates against it, so a wrong guess costs nothing.
 */
export function draftSpec(statement: string, inputs: string[]): string | null {
  if (inputs.length === 0) return null;
  const bounds = readConstraints(statement);
  const lines = inputs[0]!.replace(/\r\n/g, '\n').trim().split('\n').map((line) => line.trim().split(/\s+/));
  const alphabet = alphabetOf(inputs.flatMap((input) => input.split(/\s+/).filter((t) => t && !/^-?\d+$/.test(t))));
  const multi = bounds.has('t') && lines[0]!.length === 1 && /test ?case/i.test(statement);
  const accepts = (text: string) => {
    try {
      const parsed = parseSpec(text);
      return inputs.every((input) => validateInput(parsed, input).ok);
    } catch {
      return false;
    }
  };

  if (!multi) {
    const block = inferBlock(lines, bounds, alphabet || 'a-z', new Set());
    const text = block?.join('\n');
    return text && accepts(text) ? text : null;
  }
  const sum = readSumLimit(statement);
  for (let size = 1; size <= Math.min(8, lines.length - 1); size += 1) {
    const block = inferBlock(lines.slice(1, 1 + size), bounds, alphabet || 'a-z', new Set(['t']));
    if (!block) continue;
    const text = [`t int ${bounds.get('t')!.lo}..${bounds.get('t')!.hi}`, 'repeat t:', ...block.map((line) => `  ${line}`)];
    if (sum && block.some((line) => line.startsWith(`${sum.name} int`) || line.includes(`, ${sum.name} int`))) text.push(`sum ${sum.name} <= ${sum.max}`);
    if (accepts(text.join('\n'))) return text.join('\n');
  }
  return null;
}
