#!/usr/bin/env node
// Turns bench/results/*.json (k6 summaries written by bench/k6/gateway.js) into Markdown tables.
//   node bench/report.mjs bench/results
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? new URL('./results/', import.meta.url).pathname;
const load = (name) => {
  const file = join(dir, `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
};
// gateway CPU time per run (bench/run.sh samples /proc/<pid>/stat around each k6 run)
const ticksPerSecond = (() => {
  const env = join(dir, 'environment.txt');
  const m =
    existsSync(env) && readFileSync(env, 'utf8').match(/clock ticks per second[^:]*: (\d+)/);
  return m ? Number(m[1]) : 100;
})();
const cpuTicks = new Map(
  existsSync(join(dir, 'gateway-cpu.txt'))
    ? readFileSync(join(dir, 'gateway-cpu.txt'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => l.split(' '))
        .map(([name, ticks]) => [name, Number(ticks)])
    : [],
);
/** Gateway CPU milliseconds per request for a run, or '–'. */
const cpuPerReq = (name, r) => {
  const ticks = cpuTicks.get(name);
  if (ticks === undefined || !r?.requests?.count) return '–';
  return ((ticks * 1000) / ticksPerSecond / r.requests.count).toFixed(2);
};
const f = (n) => (n === undefined || Number.isNaN(n) ? '–' : n.toFixed(2));
const signed = (n) =>
  n === undefined || Number.isNaN(n) ? '–' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
const lat = (r, metric = 'duration_ms') => r?.[metric] ?? {};
const okRate = (r) => (r?.checks ? `${(r.checks.rate * 100).toFixed(2)} %` : '–');
const rps = (r) => (r?.requests ? r.requests.rate.toFixed(0) : '–');

const lines = [];
const out = (s = '') => lines.push(s);

out('### Latency at a constant arrival rate (ms)');
out();
out(
  '| scenario | target | p50 | p95 | p99 | overhead p50 | overhead p95 | overhead p99 | gateway CPU ms/req | checks ok |',
);
out('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
const rows = [
  ['chat, cache miss', 'chat-miss', 'direct-chat', 'duration_ms'],
  ['stream, TTFB (≈TTFT)', 'chat-stream', 'direct-chat-stream', 'waiting_ms'],
  ['stream, total', 'chat-stream', 'direct-chat-stream', 'duration_ms'],
  ['exact-cache hit', 'chat-hit', 'direct-chat', 'duration_ms'],
  ['embeddings (2 inputs)', 'embed', 'direct-embed', 'duration_ms'],
  ['GET /healthz', 'healthz', undefined, 'duration_ms'],
];
for (const [label, suffix, baseline, metric] of rows) {
  const base = baseline ? load(baseline) : undefined;
  if (base) {
    const b = lat(base, metric);
    out(
      `| ${label} | direct mock | ${f(b.med)} | ${f(b['p(95)'])} | ${f(b['p(99)'])} | | | | | ${okRate(base)} |`,
    );
  }
  for (const mode of ['off', 'on']) {
    const r = load(`${mode}-${suffix}`);
    if (!r) continue;
    const m = lat(r, metric);
    const b = base ? lat(base, metric) : {};
    out(
      `| ${label} | gateway, platform ${mode} | ${f(m.med)} | ${f(m['p(95)'])} | ${f(m['p(99)'])} | ` +
        `${base ? signed(m.med - b.med) : ''} | ${base ? signed(m['p(95)'] - b['p(95)']) : ''} | ` +
        `${base ? signed(m['p(99)'] - b['p(99)']) : ''} | ${cpuPerReq(`${mode}-${suffix}`, r)} | ${okRate(r)} |`,
    );
  }
}
out();
out('Overhead = gateway percentile − direct-mock percentile for the same request shape. For');
out('cache hits the gateway never calls the mock, so the "overhead" is relative to a full direct');
out('upstream call (negative = faster than the 0 ms upstream itself). Gateway CPU ms/req is the');
out("gateway process's user + system CPU time during the run divided by its requests.");
out();
out('### Max throughput, closed loop (req/s)');
out();
out('| scenario | target | req/s | p50 ms | p99 ms | gateway CPU ms/req | checks ok |');
out('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const [label, name] of [
  ['chat, cache miss', 'direct-max-chat'],
  ['chat, cache miss', 'off-max-chat-miss'],
  ['chat, cache miss', 'on-max-chat-miss'],
  ['exact-cache hit', 'off-max-chat-hit'],
  ['exact-cache hit', 'on-max-chat-hit'],
]) {
  const r = load(name);
  if (!r) continue;
  const target = name.startsWith('direct')
    ? 'direct mock'
    : `gateway, platform ${name.split('-')[0]}`;
  const m = lat(r);
  out(
    `| ${label} | ${target} | ${rps(r)} | ${f(m.med)} | ${f(m['p(99)'])} | ${cpuPerReq(name, r)} | ${okRate(r)} |`,
  );
}
process.stdout.write(`${lines.join('\n')}\n`);
