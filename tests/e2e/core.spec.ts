import { expect, test, type Page } from '@playwright/test';

const hour = 3600_000;
const contest = () => ({
  id: 'c1',
  title: 'Warmup',
  type: 'coding',
  status: 'registration_open',
  scoringMode: 'icpc',
  capacity: 200,
  reserved: 0,
  startsAt: new Date(Date.now() + hour).toISOString(),
  freezeAt: new Date(Date.now() + 2 * hour).toISOString(),
  endsAt: new Date(Date.now() + 3 * hour).toISOString(),
  serverNow: new Date().toISOString(),
  problemCount: 2,
  problems: [],
});

async function mockApi(page: Page) {
  let seat: unknown = null;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === '/api/auth/login' && method === 'POST') {
      await route.fulfill({ json: { access: 'access', refresh: 'refresh', user: { id: 'u1', role: 'participant', displayName: 'Neha' } } });
    } else if (path === '/api/contests') {
      await route.fulfill({ json: [contest()] });
    } else if (path === '/api/archive') {
      await route.fulfill({ json: [] });
    } else if (path === '/api/contests/c1') {
      await route.fulfill({ json: contest() });
    } else if (path === '/api/contests/c1/seat') {
      await route.fulfill({ json: seat });
    } else if (path === '/api/contests/c1/seats' && method === 'POST') {
      seat = { seatId: 's1', status: 'reserved', position: null };
      await route.fulfill({ status: 201, json: { outcome: 'reserved', seatId: 's1' } });
    } else if (path === '/api/contests/c1/leaderboard') {
      await route.fulfill({ json: [{ userId: 'u1', displayName: 'Neha', solved: 1, penalty: 12, quizPoints: 0, cells: {}, pending: {} }] });
    } else if (path === '/api/contests/c1/quiz/current') {
      await route.fulfill({ json: { serverNow: new Date().toISOString(), question: null, answer: null } });
    } else {
      await route.fulfill({ json: [] });
    }
  });
}

test('landing offers sign in and paints the default theme', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ json: [] }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Seats/ })).toBeVisible();
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  expect(bg).toBe('#ffffff');
});

test('core flow: sign in, reserve a seat, see the standing', async ({ page }) => {
  await mockApi(page);
  await page.goto('/auth');
  await page.getByLabel('Email').fill('neha@example.com');
  await page.getByLabel('Password', { exact: true }).fill('longpassword');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Contests' })).toBeVisible();
  await page.getByRole('link', { name: 'Warmup' }).first().click();
  await expect(page.getByText('2 problems')).toBeVisible();
  await page.getByRole('button', { name: 'register' }).click();
  await expect(page.getByText('registered', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /standings/ }).click();
  await expect(page.locator('tr.me')).toContainText('Neha');
  await expect(page.getByRole('cell', { name: '12' })).toBeVisible();
});

test('the theme picker switches and remembers the theme', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ json: [] }));
  await page.goto('/');
  await page.getByTitle('Change theme').click();
  await page.getByRole('button', { name: /Dracula/ }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dracula');
  await page.reload();
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  expect(bg).toBe('#282a36');
});
