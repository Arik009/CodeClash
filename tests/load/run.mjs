// Runs the k6 scripts in the grafana/k6 container against a running server and stores the
// summaries in tests/load/results.
//
//   node tests/load/run.mjs [api|leaderboard ...]
//
// BASE_URL defaults to the host server as seen from Docker Desktop (host.docker.internal:4000).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const results = path.join(here, 'results');
mkdirSync(results, { recursive: true });
const base = process.env.BASE_URL ?? (process.platform === 'linux' ? 'http://127.0.0.1:4000' : 'http://host.docker.internal:4000');
const scripts = process.argv.slice(2).length ? process.argv.slice(2) : ['api', 'leaderboard'];

const rows = [];
for (const name of scripts) {
  const args = [
    'run', '--rm', ...(process.platform === 'linux' ? ['--network', 'host'] : []),
    '-v', `${here}:/load`, '-e', `BASE_URL=${base}`,
    ...['RATE', 'DURATION', 'VUS', 'CONTEST_ID'].flatMap((key) => (process.env[key] ? ['-e', `${key}=${process.env[key]}`] : [])),
    'grafana/k6', 'run', '--quiet', '--summary-export', `/load/results/${name}.json`, `/load/${name}.js`,
  ];
  console.log(`k6 ${name} against ${base}`);
  const run = spawnSync('docker', args, { stdio: 'inherit' });
  const summary = JSON.parse(readFileSync(path.join(results, `${name}.json`), 'utf8'));
  const metric = (key) => summary.metrics[key] ?? {};
  for (const [key, value] of Object.entries(summary.metrics)) {
    if (!key.startsWith('http_req_duration') || key.includes('expected_response')) continue;
    rows.push({
      script: name,
      metric: key.replace('http_req_duration', 'latency') || 'latency',
      p50: value.med?.toFixed(1),
      p95: value['p(95)']?.toFixed(1),
      max: value.max?.toFixed(1),
    });
  }
  rows.push({
    script: name,
    metric: 'requests',
    p50: `${Math.round(metric('http_reqs').count ?? 0)} total`,
    p95: `${(metric('http_reqs').rate ?? 0).toFixed(1)}/s`,
    max: `${((metric('http_req_failed').value ?? 0) * 100).toFixed(2)}% failed`,
  });
  if (run.status !== 0) console.log(`${name}: a threshold failed (exit ${run.status})`);
}

const table = [
  '| script | metric | p50 ms | p95 ms | max ms |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.script} | ${r.metric} | ${r.p50} | ${r.p95} | ${r.max} |`),
].join('\n');
writeFileSync(path.join(results, 'k6.md'), `# k6 results\n\nRun on ${new Date().toISOString().slice(0, 10)} against ${base}.\nFor the requests row the columns are total, rate and failure share.\n\n${table}\n`);
console.log(table);
