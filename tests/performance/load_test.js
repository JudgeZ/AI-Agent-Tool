import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of requests must complete below 500ms
    http_req_failed: ['rate<0.01'],   // Error rate must be less than 1%
  },
};

export default function () {
  // Hit the health check endpoint
  const res = http.get('http://localhost:4000/health');
  
  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  sleep(1);
}

