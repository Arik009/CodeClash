import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    api: { executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s', duration: '20s', preAllocatedVUs: 50 },
  },
  thresholds: { http_req_duration: ['p(95)<300'] },
};

const base = __ENV.BASE_URL || 'http://127.0.0.1:4000';

export default function () {
  const res = http.get(`${base}/health`);
  check(res, { 'ok': (r) => r.status === 200 });
}
