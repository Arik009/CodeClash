import type { SourceLanguage } from '@codeclash/shared';

export interface RunCaseInput {
  language: SourceLanguage;
  code: string;
  stdin: string;
  expected: string;
  timeMs: number;
  memoryMb: number;
}

export type RunCase = (input: RunCaseInput) => Promise<{ verdict: string; stdout: string }>;
