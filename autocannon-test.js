const autocannon = require('autocannon');

function generateBatch() {
  const logs = [];
  const now = new Date().toISOString();
  for (let i = 0; i < 100; i++) {
    logs.push({
      timestamp: now,
      level: i % 2 === 0 ? 'info' : 'warn',
      service: 'payment-service',
      message: `Dynamic load test entry ${Math.random()}`,
      attributes: { batch_id: i, processed: true }
    });
  }
  return JSON.stringify({ logs });
}

const instance = autocannon({
  url: 'http://localhost:8080/logs',
  connections: 20,
  duration: 10,
  method: 'POST',
  headers: {
    'content-type': 'application/json'
  },
  setupClient: (client) => {
    client.on('request', () => {
      client.setBody(generateBatch());
    });
  }
}, console.log);

autocannon.track(instance, { renderProgressBar: true });