// Drives the real UI against a running dev stack: sign up, register, solve A, check standings, switch theme.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const web = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const out = process.env.OUT_DIR ?? 'tests/smoke/screens';
await mkdir(out, { recursive: true });
const stamp = Date.now();
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
};

const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (error) => check('no page errors', false, error.message));

await page.goto(`${web}/auth`);
await page.getByRole('tab', { name: 'create account' }).click();
await page.getByLabel('Display name').fill(`UI ${stamp % 10000}`);
await page.getByLabel('Email').fill(`ui-${stamp}@example.com`);
await page.getByLabel('Password', { exact: true }).fill('longpassword');
await page.getByRole('button', { name: /Create account/ }).click();
await page.getByRole('button', { name: 'Confirm email' }).click();
await page.getByRole('heading', { name: 'Contests' }).waitFor();
check('sign-up lands on contests', true);

await page.getByRole('link', { name: 'enter', exact: false }).first().click();
await page.getByRole('button', { name: /register/ }).click();
await page.getByText('competing').waitFor({ timeout: 10000 });
check('register gives a competing seat', true);

await page.getByRole('button', { name: 'Sum of two integers' }).click();
await page.getByRole('heading', { name: 'A. Sum of two integers' }).waitFor();
check('problem A opens with the Codeforces-style header', await page.getByText('time limit per test').isVisible());

await page.locator('.monaco-editor').first().click();
await page.keyboard.press('Control+A');
await page.keyboard.press('Delete');
// insertText skips per-key events, so Monaco's bracket auto-closing cannot double the parentheses.
await page.keyboard.insertText('import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)\n');
await page.keyboard.press('Control+Enter');
await page.locator('.verdict-card').waitFor({ timeout: 10000 }).catch(() => {});
check('Ctrl+Enter submits', await page.locator('.verdict-card').isVisible());
await page.locator('.verdict-card .verdict:not(.pending)').waitFor({ timeout: 90000 }).catch(() => {});
const verdict = await page.locator('.verdict-card').innerText().catch(() => 'none');
await page.screenshot({ path: `${out}/flow-accepted.png` });
check('the verdict is Accepted', /Accepted/.test(verdict), verdict.replace(/\s+/g, ' '));
check('a toast announces the verdict', await page.locator('.toast').first().isVisible());

await page.getByRole('tab', { name: /standings/ }).click();
await page.locator('tr.me').waitFor({ timeout: 15000 });
check('my row is highlighted in the standings', true, (await page.locator('tr.me').innerText()).replace(/\s+/g, ' '));
await page.screenshot({ path: `${out}/flow-standings.png` });

await page.getByTitle('Change theme').click();
await page.getByRole('dialog', { name: 'Themes' }).waitFor();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/flow-themes.png` });
await page.getByRole('button', { name: /Synthwave/ }).click();
const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
check('picking a theme repaints the page', bg === '#241b2f', bg);
await page.keyboard.press('Escape');
await page.reload();
const kept = await page.evaluate(() => document.documentElement.dataset.theme);
check('the theme survives a reload', kept === 'synthwave', kept);

await browser.close();
if (failed) process.exit(1);
