import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    load_test: {
      executor: 'constant-arrival-rate',
      rate: 300,
      timeUnit: '1s',
      duration: '120s',
      preAllocatedVUs: 500,
      maxVUs: 1000,
    },
  },
};

function randomLog() {
  const levels = ['debug', 'info', 'warn', 'error'];
  const services = ['checkout', 'auth', 'payment', 'inventory'];
  return {
    timestamp: new Date().toISOString(),
    level: levels[Math.floor(Math.random() * levels.length)],
    service: services[Math.floor(Math.random() * services.length)],
    message: `load test entry ${Math.random()}`,
    attributes: { user_id: String(Math.floor(Math.random() * 1000)), region: 'eu-west' },
  };
}

export default function () {
  const batchSize = 50;
  const logs = [];
  for (let i = 0; i < batchSize; i++) {
    logs.push(randomLog());
  }

  const payload = JSON.stringify({ logs });
  const res = http.post('http://localhost:8080/logs', payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}