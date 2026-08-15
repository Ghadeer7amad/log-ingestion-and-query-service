import autocannon from 'autocannon';

const instance = autocannon({
  url: 'http://localhost:8080/logs/aggregate?since=2026-08-01T00:00:00Z&until=2026-08-12T23:59:59Z&bucket=1h',
  connections: 2, 
  duration: 15,
  method: 'GET',
}, (err, result) => {
  if (err) throw err;
  console.log('--- GET Aggregation Test Results ---');
  console.log(`Average Latency: ${result.latency.average} ms`);
  console.log(`p90 Latency: ${result.latency.p90} ms`);
  console.log(`p97.5 Latency: ${result.latency['p97_5']} ms`);
  console.log(`2xx responses: ${result['2xx']}`);
});

autocannon.track(instance, { renderProgressBar: true });