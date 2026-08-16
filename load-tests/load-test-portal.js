import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// Mirrors the portal's four grading scenarios (load/stress/spike/breakpoint)
// against a pre-loaded ~1M-row database, with the full realistic query mix:
// ingestion, unfiltered aggregate (cache path), filtered aggregate
// (attr.<key> and q -- Postgres path), plain GET /logs, and cursor
// pagination -- not just POST /logs + unfiltered aggregate.
//
// Run with: k6 run -e SCENARIO=load|stress|spike|breakpoint load-test-portal.js
const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const SCENARIO = __ENV.SCENARIO || 'load';
const BATCH_SIZE = 50; // logs per POST -- rate below is in iterations/sec, iterations*BATCH_SIZE = logs/sec

// iterations/sec for each named logs/sec target (BATCH_SIZE=50)
const RATE = {
  r7500: 150,
  r15000: 300,
  r22500: 450,
  r30000: 600,
  r37500: 750,
  r45000: 900,
};

const STAGES = {
  // Load: sustain 15,000 logs/sec for 120s.
  load: [{ target: RATE.r15000, duration: '120s' }],
  // Stress: ramp 15,000 -> 22,500 -> 30,000 logs/sec, holding at each step.
  stress: [
    { target: RATE.r15000, duration: '10s' },
    { target: RATE.r15000, duration: '50s' },
    { target: RATE.r22500, duration: '20s' },
    { target: RATE.r22500, duration: '50s' },
    { target: RATE.r30000, duration: '20s' },
    { target: RATE.r30000, duration: '50s' },
  ],
  // Spike: 7,500 -> 30,000 -> 7,500 logs/sec.
  spike: [
    { target: RATE.r7500, duration: '30s' },
    { target: RATE.r30000, duration: '10s' },
    { target: RATE.r30000, duration: '30s' },
    { target: RATE.r7500, duration: '10s' },
    { target: RATE.r7500, duration: '30s' },
  ],
  // Breakpoint: ramp 15,000 -> 45,000 logs/sec in steps, looking for where it breaks.
  breakpoint: [
    { target: RATE.r15000, duration: '20s' },
    { target: RATE.r22500, duration: '20s' },
    { target: RATE.r30000, duration: '20s' },
    { target: RATE.r37500, duration: '20s' },
    { target: RATE.r45000, duration: '20s' },
  ],
};

export const ingest_latency = new Trend('ingest_latency_ms', true);
export const ingest_success_rate = new Rate('ingest_success_rate');
export const ingest_rejected = new Counter('ingest_rejected');
export const logs_ingested = new Counter('logs_ingested');

export const aggregate_latency = new Trend('aggregate_latency_ms', true);
export const aggregate_success_rate = new Rate('aggregate_success_rate');

export const get_logs_latency = new Trend('get_logs_latency_ms', true);
export const get_logs_success_rate = new Rate('get_logs_success_rate');

export const paginate_latency = new Trend('paginate_latency_ms', true);
export const paginate_success_rate = new Rate('paginate_success_rate');

export const overall_latency = new Trend('overall_latency_ms', true);

export const options = {
  scenarios: {
    ingest: {
      executor: 'ramping-arrival-rate',
      startRate: STAGES[SCENARIO][0].target,
      timeUnit: '1s',
      preAllocatedVUs: 1500,
      maxVUs: 3000,
      stages: STAGES[SCENARIO],
      exec: 'ingest',
    },
    aggregate_probe: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1s',
      duration: totalDuration(),
      preAllocatedVUs: 5,
      maxVUs: 10,
      exec: 'aggregateProbe',
      startTime: '3s',
    },
    get_logs_probe: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1s',
      duration: totalDuration(),
      preAllocatedVUs: 5,
      maxVUs: 10,
      exec: 'getLogsProbe',
      startTime: '3s',
    },
    paginate_probe: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '2s',
      duration: totalDuration(),
      preAllocatedVUs: 5,
      maxVUs: 10,
      exec: 'paginateProbe',
      startTime: '3s',
    },
  },
};

function totalDuration() {
  const totalSec = STAGES[SCENARIO].reduce((sum, s) => sum + parseInt(s.duration), 0);
  return `${totalSec}s`;
}

const LEVELS = ['debug', 'info', 'warn', 'error'];
const SERVICES = ['checkout', 'auth', 'payment', 'inventory'];

function randomLog(extraAttrs) {
  return {
    timestamp: new Date().toISOString(),
    level: LEVELS[Math.floor(Math.random() * LEVELS.length)],
    service: SERVICES[Math.floor(Math.random() * SERVICES.length)],
    message: `portal test entry ${Math.random()}`,
    attributes: Object.assign(
      { user_id: String(Math.floor(Math.random() * 1000)), region: 'eu-west', retries: Math.floor(Math.random() * 5) },
      extraAttrs || {}
    ),
  };
}

export function ingest() {
  const logs = [];
  for (let i = 0; i < BATCH_SIZE; i++) logs.push(randomLog());
  const start = Date.now();
  const res = http.post(`${BASE_URL}/logs`, JSON.stringify({ logs }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'ingest' },
  });
  const dur = Date.now() - start;
  const ok = res.status === 200;
  ingest_success_rate.add(ok);
  ingest_latency.add(dur);
  overall_latency.add(dur);
  if (ok) {
    try {
      const body = JSON.parse(res.body);
      logs_ingested.add(body.accepted || 0);
      ingest_rejected.add((body.rejected || []).length);
    } catch (e) {
      // non-JSON 200 shouldn't happen; still counted via ok=true/logs_ingested=0
    }
  } else {
    ingest_rejected.add(BATCH_SIZE);
  }
  check(res, { 'ingest status 200': (r) => r.status === 200 });
}

export function aggregateProbe() {
  const until = new Date();
  const since = new Date(until.getTime() - 10 * 60 * 1000);
  // Alternate unfiltered (cache path) / attr-filtered / q-filtered (Postgres path)
  const variant = Math.floor(Math.random() * 3);
  let url = `${BASE_URL}/logs/aggregate?since=${since.toISOString()}&until=${until.toISOString()}&bucket=1m`;
  if (variant === 1) url += '&attr.retries=3';
  if (variant === 2) url += '&q=entry';
  const start = Date.now();
  const res = http.get(url, { tags: { name: 'aggregate' } });
  const dur = Date.now() - start;
  aggregate_success_rate.add(res.status === 200);
  aggregate_latency.add(dur);
  overall_latency.add(dur);
  check(res, { 'aggregate status 200': (r) => r.status === 200 });
}

export function getLogsProbe() {
  // Alternate unfiltered / service-filtered / level-filtered listing
  const variant = Math.floor(Math.random() * 3);
  let url = `${BASE_URL}/logs?limit=50`;
  if (variant === 1) url += `&service=${SERVICES[Math.floor(Math.random() * SERVICES.length)]}`;
  if (variant === 2) url += `&level=${LEVELS[Math.floor(Math.random() * LEVELS.length)]}`;
  const start = Date.now();
  const res = http.get(url, { tags: { name: 'get_logs' } });
  const dur = Date.now() - start;
  get_logs_success_rate.add(res.status === 200);
  get_logs_latency.add(dur);
  overall_latency.add(dur);
  check(res, { 'get_logs status 200': (r) => r.status === 200 });
}

export function paginateProbe() {
  const start = Date.now();
  const page1 = http.get(`${BASE_URL}/logs?limit=50`, { tags: { name: 'paginate' } });
  let ok = page1.status === 200;
  if (ok) {
    try {
      const body = JSON.parse(page1.body);
      if (body.next_cursor) {
        const page2 = http.get(`${BASE_URL}/logs?limit=50&cursor=${encodeURIComponent(body.next_cursor)}`, {
          tags: { name: 'paginate' },
        });
        ok = ok && page2.status === 200;
      }
    } catch (e) {
      ok = false;
    }
  }
  const dur = Date.now() - start;
  paginate_success_rate.add(ok);
  paginate_latency.add(dur);
  overall_latency.add(dur);
}
