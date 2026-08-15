import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// Combined test that exercises every dimension in the spec simultaneously:
//  - sustained ingestion at a configurable logs/sec rate
//  - 1 aggregate request/sec while ingestion is active
//  - freshness: newly ingested data must be queryable within 20s
// Run with: k6 run -e DURATION=120s -e INGEST_RATE=300 -e BATCH_SIZE=50 load-test-full.js
// INGEST_RATE * BATCH_SIZE = target logs/sec (default 300*50 = 15,000/sec)

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const TEST_DURATION = __ENV.DURATION || '120s';
const INGEST_RATE = Number(__ENV.INGEST_RATE || 300);
const BATCH_SIZE = Number(__ENV.BATCH_SIZE || 50);

export const ingest_success_rate = new Rate('ingest_success_rate');
export const logs_ingested = new Counter('logs_ingested');
export const aggregate_latency = new Trend('aggregate_latency_ms', true);
export const aggregate_success_rate = new Rate('aggregate_success_rate');
export const freshness_seconds = new Trend('freshness_seconds', true);
export const freshness_timeouts = new Counter('freshness_timeouts');

export const options = {
  scenarios: {
    ingest: {
      executor: 'constant-arrival-rate',
      rate: INGEST_RATE,
      timeUnit: '1s',
      duration: TEST_DURATION,
      preAllocatedVUs: 400,
      maxVUs: 800,
      exec: 'ingest',
    },
    aggregate_probe: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1s',
      duration: TEST_DURATION,
      preAllocatedVUs: 5,
      maxVUs: 10,
      exec: 'aggregateProbe',
      startTime: '5s',
    },
    freshness_probe: {
      executor: 'constant-vus',
      vus: 1,
      duration: TEST_DURATION,
      exec: 'freshnessProbe',
      startTime: '2s',
    },
  },
  thresholds: {
    ingest_success_rate: ['rate>0.999'],
    aggregate_latency_ms: ['p(95)<1000'],
    freshness_seconds: ['p(95)<20'],
  },
};

const LEVELS = ['debug', 'info', 'warn', 'error'];
const SERVICES = ['checkout', 'auth', 'payment', 'inventory'];

function randomLog(extraAttrs) {
  return {
    timestamp: new Date().toISOString(),
    level: LEVELS[Math.floor(Math.random() * LEVELS.length)],
    service: SERVICES[Math.floor(Math.random() * SERVICES.length)],
    message: `load test entry ${Math.random()}`,
    attributes: Object.assign(
      { user_id: String(Math.floor(Math.random() * 1000)), region: 'eu-west' },
      extraAttrs || {}
    ),
  };
}

export function ingest() {
  const logs = [];
  for (let i = 0; i < BATCH_SIZE; i++) logs.push(randomLog());
  const res = http.post(`${BASE_URL}/logs`, JSON.stringify({ logs }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'ingest' },
  });
  const ok = res.status === 200;
  ingest_success_rate.add(ok);
  if (ok) {
    try {
      const body = JSON.parse(res.body);
      logs_ingested.add(body.accepted || 0);
    } catch (e) {
      // ignore parse errors, still counted as non-ok below via check
    }
  }
  check(res, { 'ingest status 200': (r) => r.status === 200 });
}

export function aggregateProbe() {
  const until = new Date();
  const since = new Date(until.getTime() - 10 * 60 * 1000);
  const url = `${BASE_URL}/logs/aggregate?since=${since.toISOString()}&until=${until.toISOString()}&bucket=1m`;
  const res = http.get(url, { tags: { name: 'aggregate' } });
  aggregate_success_rate.add(res.status === 200);
  aggregate_latency.add(res.timings.duration);
  check(res, {
    'aggregate status 200': (r) => r.status === 200,
    'aggregate < 1s': (r) => r.timings.duration < 1000,
  });
}

export function freshnessProbe() {
  const marker = `probe_${__VU}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const log = randomLog({ probe_id: marker });
  const insertStart = Date.now();
  const postRes = http.post(`${BASE_URL}/logs`, JSON.stringify({ logs: [log] }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'freshness_ingest' },
  });
  if (postRes.status !== 200) {
    sleep(2);
    return;
  }
  const deadline = insertStart + 20000;
  let found = false;
  while (Date.now() < deadline) {
    const getRes = http.get(`${BASE_URL}/logs?attr.probe_id=${marker}&limit=1`, {
      tags: { name: 'freshness_poll' },
    });
    if (getRes.status === 200) {
      try {
        const body = JSON.parse(getRes.body);
        if (body.logs && body.logs.length > 0) {
          found = true;
          freshness_seconds.add((Date.now() - insertStart) / 1000);
          break;
        }
      } catch (e) {}
    }
    sleep(0.5);
  }
  if (!found) {
    freshness_timeouts.add(1);
    freshness_seconds.add(20);
  }
  sleep(3);
}
