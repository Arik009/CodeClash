import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyRun, type JudgeVerdict } from './decide.js';

export interface RunRequest {
  language: 'javascript' | 'python';
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

const IMAGES = {
  javascript: process.env.RUNNER_NODE_IMAGE ?? 'node:22-alpine',
  python: process.env.RUNNER_PYTHON_IMAGE ?? 'python:3.12-alpine',
};

export function dockerArgs(req: RunRequest, workDir: string, name = containerName()): string[] {
  const file = req.language === 'python' ? 'main.py' : 'main.js';
  const program = req.language === 'python' ? ['python', `/work/${file}`] : ['node', `/work/${file}`];
  const cmd = ['timeout', '-s', 'KILL', String(Math.ceil(req.timeMs / 1000) + 2), ...program];
  return [
    'run', '--rm',
    '--name', name,
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:size=16m',
    '--memory', `${req.memoryMb}m`,
    '--memory-swap', `${req.memoryMb}m`,
    '--cpus', '1',
    '--pids-limit', '64',
    '--user', '65534:65534',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '-v', `${workDir}:/work:ro`,
    '-i',
    IMAGES[req.language],
    ...cmd,
  ];
}

export async function runInDocker(req: RunRequest): Promise<RunOutcome> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cc-run-'));
  const file = req.language === 'python' ? 'main.py' : 'main.js';
  try {
    await writeFile(path.join(dir, file), req.code, 'utf8');
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
