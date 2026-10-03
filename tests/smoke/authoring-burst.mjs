// Opens many Authoring problems quickly through the Vite proxy, like a setter clicking down the list.
const base = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@codeclash.local', password: 'codeclash' }),
}).then((r) => r.json());
const headers = { authorization: `Bearer ${login.access}` };
const problems = await fetch(`${base}/api/problems`, { headers }).then((r) => r.json());
let failures = 0;
const statuses = {};
for (let round = 0; round < 3; round += 1) {
  await Promise.all(problems.flatMap((p) => [
    `${base}/api/problem-versions/${p.versionId}`,
    `${base}/api/problem-versions/${p.versionId}/proposals`,
  ]).map(async (url) => {
    try {
      const res = await fetch(url, { headers });
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      await res.text();
    } catch (error) {
      failures += 1;
      console.error(url, error.cause?.code ?? error.message);
    }
  }));
}
console.log({ problems: problems.length, statuses, failures });
process.exit(failures ? 1 : 0);
