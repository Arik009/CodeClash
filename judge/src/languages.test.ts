import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runInDocker } from './runner.js';
import { programs } from './testdata/sum.js';

const docker = spawnSync('docker', ['version'], { encoding: 'utf8' });

describe('languages', () => {
  it.skipIf(docker.status !== 0)('accepts a sum program in each language', async () => {
    for (const program of programs) {
      const outcome = await runInDocker({
        ...program,
        stdin: '1 2\n',
        expected: '3\n',
        timeMs: program.language === 'java' ? 8000 : 5000,
        memoryMb: program.language === 'java' ? 512 : 256,
      });
      expect(outcome.verdict, `${program.language}: ${outcome.stderr}`).toBe('AC');
    }
  }, 300000);

  it.skipIf(docker.status !== 0)('reports a compile error for broken C', async () => {
    const outcome = await runInDocker({
      language: 'c',
      code: 'int main( { return 0; }\n',
      stdin: '',
      expected: '',
      timeMs: 2000,
      memoryMb: 128,
    });
    expect(outcome.verdict).toBe('CE');
  }, 120000);
});
