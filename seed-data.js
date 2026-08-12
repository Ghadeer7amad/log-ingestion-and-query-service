import http from 'k6/http';

export const options = {
  scenarios: {
    seeding: {
      executor: 'constant-arrival-rate',
      rate: 15,
      timeUnit: '1s',
      duration: '90s',
      preAllocatedVUs: 30,
      maxVUs: 100,
    },
  },
};

function randomLog() {
  const levels = ['debug', 'info', 'warn', 'error'];
  const services = ['checkout', 'auth', 'payment', 'inventory'];
  const now = Date.now();
  const randomPast = now - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000); // بيانات موزعة على آخر 30 يوم
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
  const batchSize = 700;
  const logs = [];
  for (let i = 0; i < batchSize; i++) {
    logs.push(randomLog());
  }

  const payload = JSON.stringify({ logs });
  http.post('http://localhost:8080/logs', payload, {
    headers: { 'Content-Type': 'application/json' },
  });
}