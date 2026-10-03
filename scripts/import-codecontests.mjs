// Imports verified problems from DeepMind CodeContests (CC BY 4.0) into server/data/codecontests.json.gz.
//
//   npx tsx scripts/import-codecontests.mjs [--target 120] [--files valid,test,train-00000] [--append]
//
// --append keeps the problems already in the output file and tops them up to the target.
// Parquet files are read from .cache/codecontests/<name>.parquet. Download them from
// https://huggingface.co/datasets/deepmind/code_contests/tree/main/data first.
// Every kept problem is checked in our sandbox: a reference must get AC on every kept test,
// and each kept incorrect solution must fail at least one.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { draftSpec } from '@codeclash/shared';
import { judgeBatch } from '@codeclash/judge/runner';
import {
  convertDescription, difficultyOf, limitsOf, pickTests, rejectReason, samplesText, solutionsIn, sourceOf, tagsOf, titleOf,
} from '../server/src/import/codecontests.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
  return pairs;
}, []));
const target = Number(args.target ?? 120);
const files = (args.files ?? 'train-00000,valid,test').split(',');
const caps = { easy: Math.round(target * 0.42), medium: Math.round(target * 0.38), hard: target - Math.round(target * 0.42) - Math.round(target * 0.38) };
const CONCURRENCY = Number(args.concurrency ?? 3);
const root = path.resolve(import.meta.dirname, '..');

const outFile = path.join(root, 'server', 'data', 'codecontests.json.gz');
const kept = args.append ? JSON.parse(gunzipSync(readFileSync(outFile)).toString()).problems : [];
const counts = { easy: 0, medium: 0, hard: 0 };
for (const problem of kept) counts[problem.difficulty] += 1;
const skipped = new Map();
const skip = (reason) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
const seenTitles = new Set(kept.map((problem) => problem.title));

async function verify(row) {
  const reason = rejectReason(row);
  if (reason) return skip(reason);
  const title = titleOf(row.name);
  if (seenTitles.has(title)) return skip('duplicate title');
  const rating = Number(row.cf_rating);
  const difficulty = difficultyOf(rating);
  if (counts[difficulty] >= caps[difficulty]) return skip(`${difficulty} quota full`);
  const tests = pickTests(row);
  if (tests.filter((t) => t.hidden).length < 3) return skip('fewer than 3 hidden tests fit');
  const limits = limitsOf(row);
  const cases = tests.map((t) => ({ input: t.input, output: t.output }));

  // Two accepted solutions must both match the expected output exactly. A Wrong Answer from a
  // correct solution means the problem accepts several outputs, which needs a checker we do not have.
  let reference = null;
  let agreeing = 0;
  for (const candidate of solutionsIn(row.solutions, 3)) {
    const results = await judgeBatch({ language: candidate.language, code: candidate.code, timeMs: limits.timeMs, memoryMb: limits.memoryMb }, cases);
    if (results.some((r) => r.verdict === 'WA')) return skip('correct solutions disagree (several answers)');
    if (results.length === cases.length && results.every((r) => r.verdict === 'AC')) {
      reference ??= candidate;
      agreeing += 1;
      if (agreeing >= 2) break;
    }
  }
  if (!reference) return skip('no reference passes in our sandbox');
  if (agreeing < 2) return skip('only one solution passes, cannot confirm a unique answer');

  const wrongSolutions = [];
  for (const candidate of solutionsIn(row.incorrect_solutions, 3)) {
    if (wrongSolutions.length >= 2) break;
    const results = await judgeBatch({ language: candidate.language, code: candidate.code, timeMs: limits.timeMs, memoryMb: limits.memoryMb }, cases);
    if (results.some((r) => r.verdict === 'CE')) continue;
    const failed = results.findIndex((r) => r.verdict !== 'AC');
    if (failed >= 0) wrongSolutions.push({ label: `incorrect ${wrongSolutions.length + 1}`, ...candidate, expected: results[failed].verdict });
  }

  if (counts[difficulty] >= caps[difficulty] || seenTitles.has(title)) return skip(`${difficulty} quota full`);
  counts[difficulty] += 1;
  seenTitles.add(title);
  kept.push({
    title,
    statement: convertDescription(row.description),
    samples: samplesText(row.public_tests),
    tags: tagsOf(row.cf_tags),
    difficulty,
    rating,
    limits,
    inputSpec: draftSpec(row.description, tests.map((t) => t.input)),
    tests,
    reference,
    wrongSolutions,
    source: sourceOf(row),
  });
  console.log(`kept ${kept.length}/${target} · ${difficulty} ${rating} · ${row.name} · ${reference.language}${wrongSolutions.length ? ` · ${wrongSolutions.length} wrong` : ''}`);
}

async function pool(rows) {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < rows.length && kept.length < target) {
      const row = rows[next++];
      try {
        await verify(row);
      } catch (error) {
        skip(`error: ${error instanceof Error ? error.message.slice(0, 60) : error}`);
      }
    }
  }));
}

for (const name of files) {
  if (kept.length >= target) break;
  const buffer = readFileSync(path.join(root, '.cache', 'codecontests', `${name}.parquet`));
  const file = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const metadata = parquetMetadata(file);
  const total = Number(metadata.num_rows);
  console.log(`${name}: ${total} rows`);
  for (let start = 0; start < total && kept.length < target; start += 20) {
    const rows = await parquetReadObjects({ file, metadata, compressors, rowStart: start, rowEnd: Math.min(total, start + 20) });
    await pool(rows);
  }
}

kept.sort((a, b) => a.source.contestId - b.source.contestId || a.source.index.localeCompare(b.source.index));
mkdirSync(path.dirname(outFile), { recursive: true });
const json = JSON.stringify({ dataset: 'DeepMind CodeContests', license: 'CC BY 4.0', url: 'https://github.com/google-deepmind/code_contests', problems: kept });
writeFileSync(outFile, gzipSync(json, { level: 9 }));
console.log(`wrote ${kept.length} problems (${counts.easy} easy, ${counts.medium} medium, ${counts.hard} hard), ${(json.length / 1e6).toFixed(1)} MB before gzip`);
console.log(`with a drafted input spec: ${kept.filter((p) => p.inputSpec).length}`);
console.log('skipped:', Object.fromEntries([...skipped.entries()].sort((a, b) => b[1] - a[1])));
