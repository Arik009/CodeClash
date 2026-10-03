import type { SourceLanguage } from '@codeclash/shared';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyRun, type JudgeVerdict } from './decide.js';

export interface RunRequest {
  language: SourceLanguage;
  code: string;
  stdin: string;
  expected: string;
  timeMs: number;
  memoryMb: number;
  outputLimit?: number;
}

export interface RunOutcome {
  verdict: JudgeVerdict;
  reason: string | null;
  stdout: string;
  stderr: string;
}

interface LangSpec {
  image: string;
  env: string;
  source: string;
  /** Argv run inside the image. Null means the source is executed directly. */
  compile: string[] | null;
  extra: string[];
  run: (memoryMb: number) => string[];
  pids: number;
}

const SPECS: Record<SourceLanguage, LangSpec> = {
  python: {
    image: 'python:3.12-alpine',
    env: 'RUNNER_PYTHON_IMAGE',
    source: 'main.py',
    compile: null,
    extra: [],
    run: () => ['python', '/work/main.py'],
    pids: 64,
  },
  javascript: {
    image: 'node:22-alpine',
    env: 'RUNNER_NODE_IMAGE',
    source: 'main.js',
    compile: null,
    extra: [],
    run: () => ['node', '/work/main.js'],
    pids: 64,
  },
  c: {
    image: 'gcc:14',
    env: 'RUNNER_GCC_IMAGE',
    source: 'main.c',
    compile: ['gcc', '-O2', '-pipe', '-o', '/work/main', 'main.c'],
    extra: [],
    run: () => ['/work/main'],
    pids: 64,
  },
  cpp: {
    image: 'gcc:14',
    env: 'RUNNER_GCC_IMAGE',
    source: 'main.cpp',
    compile: ['g++', '-O2', '-std=c++17', '-pipe', '-o', '/work/main', 'main.cpp'],
    extra: [],
    run: () => ['/work/main'],
    pids: 64,
  },
  java: {
    image: 'eclipse-temurin:21-jdk-alpine',
    env: 'RUNNER_JAVA_IMAGE',
    source: 'Main.java',
    compile: ['javac', '-d', '/work', 'Main.java'],
    extra: [],
    run: (memoryMb) => [
      'java',
      `-Xmx${Math.max(64, memoryMb - 128)}m`,
      '-Xss1m',
      '-Djava.io.tmpdir=/tmp',
      '-Duser.home=/tmp',
      '-cp', '/work',
      'Main',
    ],
    pids: 256,
  },
  go: {
    image: 'golang:1.23-alpine',
    env: 'RUNNER_GO_IMAGE',
    source: 'main.go',
    compile: ['go', 'build', '-o', '/work/main', 'main.go'],
    extra: ['-e', 'CGO_ENABLED=0', '-e', 'GO111MODULE=off', '-e', 'GOCACHE=/tmp/gocache', '-e', 'GOPATH=/tmp/gopath'],
    run: () => ['/work/main'],
    pids: 64,
  },
};

function spec(language: SourceLanguage): LangSpec {
  const row = SPECS[language];
  return { ...row, image: process.env[row.env] ?? row.image };
}

export function dockerArgs(req: RunRequest, workDir: string, name = containerName()): string[] {
  const lang = spec(req.language);
  const seconds = String(Math.ceil(req.timeMs / 1000) + 2);
  return [
    'run', '--rm',
    '--name', name,
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:size=64m',
    '--memory', `${req.memoryMb}m`,
    '--memory-swap', `${req.memoryMb}m`,
    '--cpus', '1',
    '--pids-limit', String(lang.pids),
    '--user', '65534:65534',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '-v', `${workDir}:/work:ro`,
    '-i',
    lang.image,
    'timeout', '-s', 'KILL', seconds,
    ...lang.run(req.memoryMb),
  ];
}

function compileArgs(language: SourceLanguage, workDir: string, name: string): string[] {
  const lang = spec(language);
  return [
    'run', '--rm',
    '--name', name,
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:size=256m',
    '--memory', '512m',
    '--memory-swap', '512m',
    '--cpus', '1',
    '--pids-limit', '256',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '-v', `${workDir}:/work`,
    '-w', '/work',
    ...lang.extra,
    lang.image,
    'timeout', '-s', 'KILL', '30',
    ...(lang.compile ?? []),
  ];
}

/** Writes the source and compiles it when the language needs that. Returns a CE reason, or null. */
async function prepare(language: SourceLanguage, code: string, dir: string) {
  const lang = spec(language);
  await chmod(dir, 0o755);
  await writeFile(path.join(dir, lang.source), code, { encoding: 'utf8', mode: 0o644 });
  if (!lang.compile) return null;
  const name = containerName();
  const compiled = await execDocker(compileArgs(language, dir, name), name, '', 30_000, 8_000);
  if (compiled.timedOut || compiled.exitCode !== 0) {
    const detail = (compiled.stderr || compiled.stdout || 'compilation failed').slice(0, 500);
    return { reason: compiled.timedOut ? 'compilation timed out' : detail, stderr: compiled.stderr };
  }
  return null;
}

export async function runInDocker(req: RunRequest): Promise<RunOutcome> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cc-run-'));
  try {
    const failed = await prepare(req.language, req.code, dir);
    if (failed) return { verdict: 'CE', reason: failed.reason, stdout: '', stderr: failed.stderr };
    const name = containerName();
    const outputLimit = req.outputLimit ?? 64_000;
    const result = await execDocker(dockerArgs(req, dir, name), name, req.stdin, req.timeMs, outputLimit);
    const classified = classifyRun({
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      expected: req.expected,
      outputLimit,
      signal: result.signal,
    });
    return { ...classified, stdout: result.stdout, stderr: result.stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface BatchRequest {
  language: SourceLanguage;
  code: string;
  inputs: string[];
  timeMs: number;
  memoryMb: number;
  outputLimit?: number;
}

export interface BatchCase {
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
  stdout: string;
  stderr: string;
}

export interface BatchResult {
  compileError: string | null;
  cases: BatchCase[];
}

/**
 * One shell loop over every input in one container. Each input gets its own `timeout`, and the
 * output of each case is framed by a random marker so program output cannot forge a boundary.
 */
function batchScript(nonce: string, count: number, seconds: number, cap: number, argv: string[]) {
  const program = argv.join(' ');
  return [
    'i=0',
    `while [ $i -lt ${count} ]; do`,
    '  read s _ < /proc/uptime',
    `  { timeout -s KILL ${seconds} ${program} < /work/in/$i.in 2>/tmp/e; echo $? > /tmp/rc; } | head -c ${cap + 1} > /tmp/o`,
    '  read e _ < /proc/uptime',
    '  rc=$(cat /tmp/rc 2>/dev/null || echo 1)',
    `  printf '@@${nonce} %s %s %s %s\\n' "$i" "$rc" "$s" "$e"`,
    '  cat /tmp/o',
    `  printf '\\n@@${nonce}-err\\n'`,
    '  head -c 2000 /tmp/e',
    `  printf '\\n@@${nonce}-end\\n'`,
    '  i=$((i+1))',
    'done',
    '',
  ].join('\n');
}

export function parseBatch(raw: string, nonce: string, count: number, timeMs: number): BatchCase[] {
  const cases: BatchCase[] = [];
  const header = new RegExp(`^@@${nonce} (\\d+) (\\d+) ([\\d.]+) ([\\d.]+)\\n`, 'gm');
  const matches = [...raw.matchAll(header)];
  for (const match of matches) {
    const start = match.index! + match[0].length;
    const errAt = raw.indexOf(`\n@@${nonce}-err\n`, start);
    const endAt = raw.indexOf(`\n@@${nonce}-end\n`, errAt);
    if (errAt < 0 || endAt < 0) break;
    const exitCode = Number(match[2]);
    const ms = Math.max(0, Math.round((Number(match[4]) - Number(match[3])) * 1000));
    cases[Number(match[1])] = {
      exitCode,
      ms,
      timedOut: ms >= timeMs || exitCode === 124,
      stdout: raw.slice(start, errAt),
      stderr: raw.slice(errAt + nonce.length + 8, endAt),
    };
  }
  return Array.from({ length: count }, (_, i) => cases[i] ?? { exitCode: null, timedOut: true, ms: timeMs, stdout: '', stderr: 'not run' });
}

export async function runBatch(req: BatchRequest): Promise<BatchResult> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cc-run-'));
  try {
    const failed = await prepare(req.language, req.code, dir);
    if (failed) return { compileError: failed.reason, cases: [] };
    if (req.inputs.length === 0) return { compileError: null, cases: [] };
    const lang = spec(req.language);
    const cap = req.outputLimit ?? 64_000;
    const nonce = randomBytes(8).toString('hex');
    const seconds = Math.ceil(req.timeMs / 1000) + 1;
    await mkdir(path.join(dir, 'in'), { mode: 0o755 });
    await Promise.all(req.inputs.map((input, i) => writeFile(path.join(dir, 'in', `${i}.in`), input, { mode: 0o644 })));
    await writeFile(path.join(dir, 'run.sh'), batchScript(nonce, req.inputs.length, seconds, cap, lang.run(req.memoryMb)), { mode: 0o755 });
    const name = containerName();
    const args = dockerArgs({ ...req, stdin: '', expected: '' }, dir, name);
    const image = args.indexOf(lang.image);
    const command = [...args.slice(0, image + 1), 'sh', '/work/run.sh'];
    const wall = req.inputs.length * (seconds + 1) * 1000 + 10_000;
    const result = await execDocker(command, name, '', wall, req.inputs.length * (cap + 2_200) + 4_096);
    return { compileError: null, cases: parseBatch(result.stdout, nonce, req.inputs.length, req.timeMs) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Judge verdicts for a batch: same rules as one container per test. */
export async function judgeBatch(
  req: Omit<BatchRequest, 'inputs'>,
  tests: { input: string; output: string }[],
): Promise<RunOutcome[]> {
  const outputLimit = req.outputLimit ?? 64_000;
  const batch = await runBatch({ ...req, inputs: tests.map((t) => t.input), outputLimit });
  if (batch.compileError !== null) {
    return tests.map(() => ({ verdict: 'CE', reason: batch.compileError, stdout: '', stderr: batch.compileError ?? '' }));
  }
  return batch.cases.map((run, i) => ({
    ...classifyRun({
      timedOut: run.timedOut,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      expected: tests[i]!.output,
      outputLimit,
      signal: null,
    }),
    stdout: run.stdout,
    stderr: run.stderr,
  }));
}

function containerName() {
  return `cc-run-${randomBytes(8).toString('hex')}`;
}

/** Killing the docker CLI does not stop the container, so it is killed by name. */
function killContainer(name: string) {
  return new Promise<void>((resolve) => {
    const killer = spawn('docker', ['kill', name], { stdio: 'ignore' });
    killer.on('error', () => resolve());
    killer.on('close', () => resolve());
  });
}

function execDocker(args: string[], name: string, stdin: string, timeMs: number, outputLimit: number) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; signal: string | null }>((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void killContainer(name).finally(() => child.kill('SIGKILL'));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeMs);
    child.stdout.on('data', (chunk) => {
      if (stdout.length > outputLimit) return;
      stdout += chunk.toString();
      if (stdout.length > outputLimit) stop();
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: error.message, exitCode: 1, timedOut: false, signal: null });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut, signal });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}
