import type { SourceLanguage } from '@codeclash/shared';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
