import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runInDocker } from './runner.js';

const docker = spawnSync('docker', ['version'], { encoding: 'utf8' });

const programs: { language: 'python' | 'javascript' | 'c' | 'cpp' | 'java' | 'go'; code: string }[] = [
  {
    language: 'python',
    code: 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)\n',
  },
  {
    language: 'javascript',
    code: "const fs = require('fs');\nconst [a, b] = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(a + b);\n",
  },
  {
    language: 'c',
    code: '#include <stdio.h>\nint main(void) {\n  int a, b;\n  if (scanf("%d %d", &a, &b) != 2) return 1;\n  printf("%d\\n", a + b);\n  return 0;\n}\n',
  },
  {
    language: 'cpp',
    code: '#include <iostream>\nint main() {\n  int a, b;\n  std::cin >> a >> b;\n  std::cout << a + b << "\\n";\n  return 0;\n}\n',
  },
  {
    language: 'java',
    code: 'import java.util.Scanner;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    System.out.println(in.nextInt() + in.nextInt());\n  }\n}\n',
  },
  {
    language: 'go',
    code: 'package main\nimport "fmt"\nfunc main() {\n  var a, b int\n  fmt.Scan(&a, &b)\n  fmt.Println(a + b)\n}\n',
  },
];

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
