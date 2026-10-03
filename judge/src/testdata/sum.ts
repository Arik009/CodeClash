import type { SourceLanguage } from '@codeclash/shared';

/** Reads two integers and prints their sum, once per language. */
export const programs: { language: SourceLanguage; code: string }[] = [
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
