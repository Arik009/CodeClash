import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 50,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<1000'],
  },
};

const base = __ENV.BASE_URL || 'http://127.0.0.1:4000';
const contest = __ENV.CONTEST_ID;

export default function () {
  const res = http.get(`${base}/api/contests/${contest}/leaderboard`);
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(0.2);
}
