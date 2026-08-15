import autocannon from 'autocannon';

const BATCH_SIZE = 1000; 

function generateBatch() {
  const logs = [];
  const now = new Date().toISOString();
  for (let i = 0; i < BATCH_SIZE; i++) {
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
  connections: 30, 
  duration: 30, 
  method: 'POST',
  headers: {
    'content-type': 'application/json'
  },
  setupClient: (client) => {
    client.on('request', () => {
      client.setBody(generateBatch());
    });
  }
}, (err, result) => {
  if (err) {
    console.error('Test Error:', err);
  } else {
    const avgReqSec = result.requests.average || 0;
    console.log('\n==============================');
    console.log('Final Test Results:');
    console.log(`Total Requests: ${result.requests.total}`);
    console.log(`Average Requests / Sec: ${avgReqSec}`);
    console.log(`Average Logs / Sec: ~${Math.round(avgReqSec * BATCH_SIZE)} logs/sec`);
    console.log('==============================\n');
  }
});


instance.on('tick', () => {
  console.log('Current Speed -> Running test tick...');
});

autocannon.track(instance, { renderProgressBar: true });