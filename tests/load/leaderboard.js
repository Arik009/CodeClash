// The leaderboard under a crowd refreshing it during a live round. Run with tests/load/run.mjs.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: Number(__ENV.VUS || 50),
  duration: __ENV.DURATION || '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

const base = __ENV.BASE_URL || 'http://127.0.0.1:4000';

export function setup() {
  if (__ENV.CONTEST_ID) return { contestId: __ENV.CONTEST_ID };
  const contests = http.get(`${base}/api/contests`).json();
  return { contestId: (contests.find((c) => c.status === 'running') || contests[0]).id };
}

export default function (data) {
  const res = http.get(`${base}/api/contests/${data.contestId}/leaderboard`);
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(0.2);
}
