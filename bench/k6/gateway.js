// k6 load script for Switchyard benchmarks (bench/run.sh drives it).
//
// Env:
//   BASE_URL   http://127.0.0.1:18787/v1 (gateway) or the mock provider's /v1 (direct baseline)
//   KEY        bearer key (the mock ignores it)
//   SCENARIO   chat | stream | hit | embed | health
//   MODEL      route (gateway) or upstream model (direct)
//   EXECUTOR   rate (constant arrival rate, latency) | vus (closed loop, max throughput)
//   RATE       requests/s for EXECUTOR=rate      VUS   virtual users for EXECUTOR=vus
//   DURATION   e.g. 20s                          OUT   JSON summary path
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL;
const SCENARIO = __ENV.SCENARIO || 'chat';
const MODEL = __ENV.MODEL || 'chat';
const EXECUTOR = __ENV.EXECUTOR || 'rate';
const DURATION = __ENV.DURATION || '20s';

const scenario =
  EXECUTOR === 'vus'
    ? { executor: 'constant-vus', vus: Number(__ENV.VUS || 32), duration: DURATION }
    : {
        executor: 'constant-arrival-rate',
        rate: Number(__ENV.RATE || 200),
        timeUnit: '1s',
        duration: DURATION,
        preAllocatedVUs: 50,
        maxVUs: 200,
      };

export const options = {
  scenarios: { load: scenario },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: SCENARIO !== 'stream',
  // a sample is "failed" for any non-2xx; thresholds only report, they never abort
  thresholds: { http_req_failed: ['rate<0.01'] },
};

const params = {
  headers: { authorization: `Bearer ${__ENV.KEY || 'none'}`, 'content-type': 'application/json' },
};

// ~60 prompt tokens, ~same completion (mock-echo repeats the last user message).
const PROMPT =
  'Summarize the incident: the payment service returned intermittent 503 errors for twelve ' +
  'minutes after a configuration rollout; retries masked most failures but p99 latency doubled.';

function body(unique) {
  if (SCENARIO === 'embed')
    return JSON.stringify({ model: MODEL, input: [`${PROMPT} ${unique}`, `query ${unique}`] });
  const msg = { role: 'user', content: unique === '' ? PROMPT : `${PROMPT} [${unique}]` };
  const req = { model: MODEL, messages: [msg] };
  if (SCENARIO === 'stream') {
    req.stream = true;
    req.stream_options = { include_usage: true };
  }
  return JSON.stringify(req);
}

export function setup() {
  // warm the exact cache for the hit scenario (and the tokenizer for everything else)
  if (SCENARIO === 'health') return;
  const path = SCENARIO === 'embed' ? 'embeddings' : 'chat/completions';
  const res = http.post(`${BASE}/${path}`, body(''), params);
  if (res.status !== 200) throw new Error(`warm-up failed: ${res.status} ${res.body}`);
  if (SCENARIO === 'hit') {
    const again = http.post(`${BASE}/chat/completions`, body(''), params);
    if (again.headers['X-Sy-Cache'] !== 'hit') throw new Error('cache did not hit after warm-up');
  }
}

export default function () {
  // unique content per request → guaranteed cache miss (except the hit scenario)
  const unique = SCENARIO === 'hit' ? '' : `${exec.vu.idInTest}-${exec.scenario.iterationInTest}`;
  let res;
  if (SCENARIO === 'health') res = http.get(BASE.replace(/\/v1$/, '/healthz'));
  else if (SCENARIO === 'embed') res = http.post(`${BASE}/embeddings`, body(unique), params);
  else res = http.post(`${BASE}/chat/completions`, body(unique), params);
  check(res, {
    200: (r) => r.status === 200,
    ...(SCENARIO === 'stream' ? { '[DONE]': (r) => String(r.body).includes('[DONE]') } : {}),
    ...(SCENARIO === 'hit' ? { 'cache hit': (r) => r.headers['X-Sy-Cache'] === 'hit' } : {}),
  });
}

export function handleSummary(data) {
  const m = data.metrics;
  const pick = (name) => (m[name] ? m[name].values : undefined);
  const out = {
    scenario: SCENARIO,
    executor: EXECUTOR,
    target: BASE,
    model: MODEL,
    rate: EXECUTOR === 'rate' ? Number(__ENV.RATE || 200) : null,
    vus: EXECUTOR === 'vus' ? Number(__ENV.VUS || 32) : null,
    duration: DURATION,
    requests: pick('http_reqs'),
    failed: pick('http_req_failed'),
    checks: pick('checks'),
    // full request time; for SSE this is time to [DONE]
    duration_ms: pick('http_req_duration'),
    // time to first byte; for SSE the gateway flushes headers with the first chunk → TTFT proxy
    waiting_ms: pick('http_req_waiting'),
    dropped_iterations: pick('dropped_iterations'),
  };
  const file = __ENV.OUT;
  const result = { stdout: `${JSON.stringify(out)}\n` };
  if (file) result[file] = JSON.stringify(out, null, 2);
  return result;
}
