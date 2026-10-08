import type { SourceLanguage } from '@codeclash/shared';
import AdmZip from 'adm-zip';
import { HttpError } from './errors.js';

export interface RunCaseInput {
  language: SourceLanguage;
  code: string;
  stdin: string;
  expected: string;
  timeMs: number;
  memoryMb: number;
}

export type RunCase = (input: RunCaseInput) => Promise<{ verdict: string; stdout: string }>;

export function testsFromZip(buffer: Buffer) {
  const zip = new AdmZip(buffer);
  const files = new Map<string, string>();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/').split('/').pop() ?? '';
    files.set(name, entry.getData().toString('utf8'));
  }
  const tests: { input: string; output: string; hidden: boolean }[] = [];
  for (const [name, input] of files) {
    if (!name.endsWith('.in')) continue;
    const output = files.get(`${name.slice(0, -3)}.out`);
    if (output === undefined) continue;
    tests.push({ input, output, hidden: !name.startsWith('sample') });
  }
  if (tests.length === 0) throw new HttpError(400, 'Zip needs paired .in and .out files');
  return tests;
}
