// Full-page screenshots of the main screens against a running dev stack.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const web = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const out = process.env.OUT_DIR ?? 'tests/smoke/screens';
await mkdir(out, { recursive: true });

const login = await fetch(`${web}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@codeclash.local', password: 'codeclash' }),
}).then((r) => r.json());
const contests = await fetch(`${web}/api/contests`).then((r) => r.json());
const live = contests.find((c) => c.status === 'running') ?? contests[0];
const archive = await fetch(`${web}/api/archive`).then((r) => r.json()).then((page) => page.items);
const problems = await fetch(`${web}/api/problems`, { headers: { authorization: `Bearer ${login.access}` } }).then((r) => r.json());

const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
const page = await browser.newPage({ viewport: { width: Number(process.env.WIDTH ?? 1360), height: 900 } });
await page.goto(web);
await page.evaluate((session) => localStorage.setItem('codeclash.session', JSON.stringify(session)), login);

// [name, path, theme]
const shots = [
  ['home', '/', 'paper'],
  ['arena', '/arena', 'paper'],
  ['problemset', '/problemset', 'paper'],
  ['room', `/arena/${live.id}`, 'paper'],
  ['room-problem', `/arena/${live.id}?p=A`, 'paper'],
  ['room-standings', `/arena/${live.id}?tab=standings`, 'paper'],
  ['room-problem-dracula', `/arena/${live.id}?p=A`, 'dracula'],
  ['practice-nord', `/practice/${archive[0]?.versionId}`, 'nord'],
  ['control-tokyo', '/control', 'tokyo'],
  ['authoring-latte', `/authoring?v=${problems[0]?.versionId}`, 'latte'],
  ['admin-gruvbox', '/admin', 'gruvbox'],
  ['missing-terminal', '/nowhere', 'terminal'],
];
for (const [name, path, theme] of shots) {
  await page.evaluate((id) => localStorage.setItem('cc.theme', id), theme);
  await page.goto(`${web}${path}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  console.log(`${out}/${name}.png`);
}
await browser.close();
