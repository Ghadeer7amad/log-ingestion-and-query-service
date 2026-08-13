import http from 'k6/http';

const TARGET_LOGS = 1000000;
const BATCH_SIZE = 1000;
const TOTAL_BATCHES = Math.ceil(TARGET_LOGS / BATCH_SIZE);

export const options = {
  scenarios: {
    seeding: {
      executor: 'shared-iterations',
      vus: 20,
      iterations: TOTAL_BATCHES,
      maxDuration: '5m',
    },
  },
};

function randomLog() {
  const levels = ['debug', 'info', 'warn', 'error'];
  const services = ['checkout', 'auth', 'payment', 'inventory'];
  const now = Date.now();
  const randomPast = now - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000);
  return {
    timestamp: new Date(randomPast).toISOString(),
    level: levels[Math.floor(Math.random() * levels.length)],
    service: services[Math.floor(Math.random() * services.length)],
    message: `seed log message ${Math.random()}`,
    attributes: {
      user_id: String(Math.floor(Math.random() * 1000)),
      region: 'eu-west',
    },
  };
}

export default function () {
  const logs = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    logs.push(randomLog());
  }

  const payload = JSON.stringify({ logs });
  http.post('http://localhost:8080/logs', payload, {
    headers: { 'Content-Type': 'application/json' },
  });
}