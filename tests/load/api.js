// Read traffic a contest day produces: the landing page, the contest list, problemset pages,
// one problem statement and the live leaderboard. Run with tests/load/run.mjs.
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    browse: { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 100), timeUnit: '1s', duration: __ENV.DURATION || '30s', preAllocatedVUs: 60, maxVUs: 200 },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{route:contests}': ['p(95)<300'],
    'http_req_duration{route:archive}': ['p(95)<500'],
    'http_req_duration{route:stats}': ['p(95)<500'],
    'http_req_duration{route:problem}': ['p(95)<300'],
    'http_req_duration{route:leaderboard}': ['p(95)<500'],
  },
};

const base = __ENV.BASE_URL || 'http://127.0.0.1:4000';

export function setup() {
  const contests = http.get(`${base}/api/contests`).json();
  const live = contests.find((c) => c.status === 'running') || contests[0];
  const archive = http.get(`${base}/api/archive?pageSize=50`).json();
  return { contestId: live.id, versions: archive.items.map((item) => item.versionId), pages: Math.ceil(archive.total / 25) };
}

export default function (data) {
  const roll = Math.random();
  let res;
  if (roll < 0.2) {
    res = http.get(`${base}/api/contests`, { tags: { route: 'contests' } });
  } else if (roll < 0.45) {
    const page = 1 + Math.floor(Math.random() * data.pages);
    res = http.get(`${base}/api/archive?page=${page}&pageSize=25`, { tags: { route: 'archive' } });
  } else if (roll < 0.55) {
    res = http.get(`${base}/api/stats`, { tags: { route: 'stats' } });
  } else if (roll < 0.75) {
    const version = data.versions[Math.floor(Math.random() * data.versions.length)];
    res = http.get(`${base}/api/problem-versions/${version}/public`, { tags: { route: 'problem' } });
  } else {
    res = http.get(`${base}/api/contests/${data.contestId}/leaderboard`, { tags: { route: 'leaderboard' } });
  }
  check(res, { 'status 200': (r) => r.status === 200 });
}
