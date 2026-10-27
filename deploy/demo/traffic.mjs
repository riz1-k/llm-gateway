#!/usr/bin/env node
// Switchyard demo traffic generator (no dependencies; Node ≥ 22).
//
//   node deploy/demo/traffic.mjs [--url http://127.0.0.1:8797] [--duration 120] [--concurrency 4]
//   env: GATEWAY_URL, SWITCHYARD_ADMIN_TOKEN, DURATION_S, CONCURRENCY
//
// Against the compose / kind stacks (config/gateway.compose.yaml, mock upstreams) it:
//   1. ensures the demo teams exist with monthly budgets (docsqa, opsagent, evals + a tiny
//      "sandbox" budget) and issues fresh `demo-traffic` keys through the admin API
//      (rotating the previous run's keys, so nothing accumulates);
//   2. sends mixed traffic for --duration seconds: chat (JSON + streaming), embeddings, rerank,
//      judge calls with repeated prompts (cache hits), routes with flaky / throttled primaries
//      (retries, fallbacks, breaker trips), a burst on an rpm-limited key (429) and priced calls
//      on the sandbox team until its budget is exhausted (402);
//   3. prints a summary and exits non-zero unless every scenario was observed.
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    'admin-token': { type: 'string' },
    duration: { type: 'string' },
    concurrency: { type: 'string' },
  },
});
const BASE = (values.url ?? process.env.GATEWAY_URL ?? 'http://127.0.0.1:8797').replace(/\/$/, '');
const ADMIN =
  values['admin-token'] ?? process.env.SWITCHYARD_ADMIN_TOKEN ?? 'sk-sy-demo-admin-token';
const DURATION_S = Number(values.duration ?? process.env.DURATION_S ?? 120);
const CONCURRENCY = Number(values.concurrency ?? process.env.CONCURRENCY ?? 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const log = (msg) => process.stdout.write(`${msg}\n`);

// ── admin API ────────────────────────────────────────────────────────────────────────────────
async function admin(method, path, body) {
  const res = await fetch(`${BASE}/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      'content-type': 'application/json',
      'x-sy-actor': 'demo-traffic',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok && res.status !== 404) {
    throw new Error(`${method} /admin${path} → ${res.status}: ${json.error?.message ?? text}`);
  }
  return { status: res.status, json };
}

const TEAMS = [
  { slug: 'docsqa', name: 'DocsQA', monthly: 50 },
  { slug: 'opsagent', name: 'OpsAgent', monthly: 50 },
  { slug: 'evals', name: 'Evals', monthly: 100 },
  // Tiny budget: a few priced calls succeed, then the gateway answers 402 budget_exceeded.
  { slug: 'sandbox', name: 'Sandbox (tiny budget)', monthly: 0.002 },
];

async function ensureTeam(t) {
  const existing = await admin('GET', `/teams/${t.slug}`);
  if (existing.status === 404) await admin('POST', '/teams', { slug: t.slug, name: t.name });
  await admin('PUT', `/teams/${t.slug}/budgets`, {
    monthly: { limit_usd: t.monthly, soft_threshold: 0.8, action: 'block' },
  });
}

/** Returns a fresh plaintext for `name` (rotating last run's key so keys don't pile up). */
async function issueKey(team, name, extra = {}) {
  const { json } = await admin('GET', `/teams/${team}/keys`);
  const prev = (json.data ?? []).find((k) => k.name === name && k.status === 'active');
  if (prev) return (await admin('POST', `/keys/${prev.id}/rotate`, { grace_s: 0 })).json.key;
  return (await admin('POST', `/teams/${team}/keys`, { name, ...extra })).json.key;
}

// ── traffic ──────────────────────────────────────────────────────────────────────────────────
const DOCS = [
  'Hono is a small, simple, and ultrafast web framework built on Web Standards.',
  'Middleware in Hono runs before and after the handler, in the order it was registered.',
  'The Context object carries the request, response helpers, and per-request variables.',
  'Hono runs on Cloudflare Workers, Deno, Bun, Node.js and other runtimes.',
  'Route parameters are read with c.req.param() and query strings with c.req.query().',
  'Validation middleware can check JSON bodies, forms, queries and headers with zod.',
];
const QUESTIONS = [
  'What is Hono built on?',
  'In which order does middleware run?',
  'What does the Context object carry?',
  'Which runtimes does Hono support?',
  'How do I read route parameters?',
  'How can I validate a JSON body?',
  'Is Hono fast?',
  'What is middleware?',
];
const OPS = [
  'Where is order ORD-20017 and when will it arrive?',
  'Customer asks for a refund on ORD-20003, it arrived damaged.',
  'Summarise the last three tickets for customer C-1042.',
  'Has payment pi_3 for ORD-20021 been captured?',
  'Draft a reply apologising for the delayed shipment of ORD-20030.',
];
const ragPrompt = (q) =>
  `${DOCS.map((d, i) => `<source id="${i + 1}" title="hono-docs">${d}</source>`).join('\n')}\n\nQuestion: ${q}`;

const stats = new Map(); // `${team} ${route} ${status}` → count
const seen = { cacheHits: 0, fallbacks: 0, s429: 0, s402: 0, s5xx: 0, streams: 0, total: 0 };

function record(team, route, status, headers) {
  const k = `${team.padEnd(9)} ${route.padEnd(15)} ${status}`;
  stats.set(k, (stats.get(k) ?? 0) + 1);
  seen.total++;
  if (status === 429) seen.s429++;
  if (status === 402) seen.s402++;
  if (status >= 500) seen.s5xx++;
  const cache = headers.get('x-sy-cache');
  if (cache === 'hit' || cache === 'semantic-hit') seen.cacheHits++;
  seen.fallbacks += Number(headers.get('x-sy-fallbacks') ?? 0);
}

async function call(team, key, path, body, route = body.model) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'x-sy-user': `${team}-demo-user`,
        'x-sy-tags': 'demo',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    await res.arrayBuffer(); // drain (also consumes SSE streams to the end)
    if (body.stream && res.ok) seen.streams++;
    record(team, route, res.status, res.headers);
    return res.status;
  } catch (err) {
    record(team, route, 'ERR', new Headers());
    log(`  ! ${team} ${route}: ${err.message}`);
    return 0;
  }
}

const chat = (model, content, extra = {}) => ({
  model,
  messages: [
    { role: 'system', content: 'Answer only from the sources and cite them like [1].' },
    { role: 'user', content },
  ],
  max_tokens: 128,
  ...extra,
});

function scenarios(keys) {
  let sandboxN = 0;
  return [
    // weight, fn
    [
      5,
      () =>
        call(
          'docsqa',
          keys.docsqa,
          '/v1/chat/completions',
          chat('docsqa-chat', ragPrompt(pick(QUESTIONS))),
        ),
    ],
    [
      2,
      () =>
        call(
          'docsqa',
          keys.docsqa,
          '/v1/chat/completions',
          chat(
            'docsqa-chat',
            ragPrompt(`${pick(QUESTIONS)} (${Math.random().toString(36).slice(2, 6)})`),
            { stream: true, stream_options: { include_usage: true } },
          ),
        ),
    ],
    [
      2,
      () =>
        call(
          'docsqa',
          keys.docsqa,
          '/v1/chat/completions',
          chat('docsqa-fast', `Rewrite as a search query: ${pick(QUESTIONS)}`, { max_tokens: 48 }),
        ),
    ],
    [
      3,
      () =>
        call('docsqa', keys.docsqa, '/v1/embeddings', {
          model: 'docsqa-embed',
          input: [pick(QUESTIONS), pick(DOCS)],
          input_type: 'query',
        }),
    ],
    [
      2,
      () =>
        call('docsqa', keys.docsqa, '/v1/rerank', {
          model: 'docsqa-rerank',
          query: pick(QUESTIONS),
          documents: DOCS,
          top_n: 3,
        }),
    ],
    [
      5,
      () =>
        call(
          'opsagent',
          keys.opsagent,
          '/v1/chat/completions',
          chat('opsagent-chat', `${pick(OPS)} #${Math.floor(Math.random() * 40)}`, {
            max_tokens: 192,
            tools: [
              {
                type: 'function',
                function: {
                  name: 'get_order',
                  description: 'Look up an order',
                  parameters: {
                    type: 'object',
                    properties: { order_id: { type: 'string' } },
                    required: ['order_id'],
                  },
                },
              },
            ],
          }),
        ),
    ],
    [
      3,
      () =>
        call(
          'evals',
          keys.evals,
          '/v1/chat/completions',
          chat(
            pick(['docsqa-judge', 'opsagent-judge']),
            `Grade this answer 1-5: ${pick(QUESTIONS)}`,
            { max_tokens: 64 },
          ),
        ),
    ],
    [
      1,
      () =>
        call(
          'sandbox',
          keys.sandbox,
          '/v1/chat/completions',
          chat('docsqa-chat', ragPrompt(`${pick(QUESTIONS)} [sandbox ${sandboxN++}]`), {
            max_tokens: 64,
          }),
        ),
    ],
  ];
}

async function worker(list, deadline) {
  const total = list.reduce((s, [w]) => s + w, 0);
  while (Date.now() < deadline) {
    let r = Math.random() * total;
    const [, fn] = list.find(([w]) => (r -= w) < 0) ?? list[0];
    await fn();
    await sleep(150 + Math.random() * 250);
  }
}

/** Bursts on an rpm-limited key: the first 5 calls of the minute pass, the rest get 429. */
async function rateLimitBursts(key, deadline) {
  while (Date.now() < deadline) {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call(
          'evals',
          key,
          '/v1/chat/completions',
          chat('docsqa-judge', `burst ${Date.now()} ${i}`, { max_tokens: 16 }),
          'docsqa-judge',
        ),
      ),
    );
    await sleep(Math.min(30_000, Math.max(0, deadline - Date.now())));
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
async function main() {
  log(`Switchyard demo traffic → ${BASE} (${DURATION_S}s, ${CONCURRENCY} workers)`);
  for (let i = 0; ; i++) {
    const ok = await fetch(`${BASE}/readyz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (i >= 60) throw new Error(`${BASE}/readyz not ready after 60 s`);
    await sleep(1000);
  }
  for (const t of TEAMS) await ensureTeam(t);
  const keys = {
    docsqa: await issueKey('docsqa', 'demo-traffic', {
      allowed_routes: ['docsqa-chat', 'docsqa-fast', 'docsqa-embed', 'docsqa-rerank'],
    }),
    opsagent: await issueKey('opsagent', 'demo-traffic', {
      allowed_routes: ['opsagent-chat', 'opsagent-judge'],
    }),
    evals: await issueKey('evals', 'demo-traffic'),
    sandbox: await issueKey('sandbox', 'demo-traffic', { allowed_routes: ['docsqa-chat'] }),
    throttled: await issueKey('evals', 'demo-rpm-limited', { rpm_limit: 5 }),
  };
  log(`teams: ${TEAMS.map((t) => `${t.slug} ($${t.monthly}/month)`).join(', ')}; keys issued`);

  const deadline = Date.now() + DURATION_S * 1000;
  const list = scenarios(keys);
  const progress = setInterval(
    () =>
      log(
        `  … ${seen.total} requests (cache hits ${seen.cacheHits}, fallbacks ${seen.fallbacks}, 429 ${seen.s429}, 402 ${seen.s402})`,
      ),
    15_000,
  );
  await Promise.all([
    ...Array.from({ length: CONCURRENCY }, () => worker(list, deadline)),
    rateLimitBursts(keys.throttled, deadline),
  ]);
  clearInterval(progress);

  log('\nteam      route           status  count');
  for (const [k, n] of [...stats.entries()].sort()) log(`${k.padEnd(32)} ${n}`);
  log(
    `\ntotal ${seen.total} · cache hits ${seen.cacheHits} · fallbacks ${seen.fallbacks} · streams ${seen.streams} · ` +
      `429 ${seen.s429} · 402 ${seen.s402} · 5xx ${seen.s5xx}`,
  );
  const missing = Object.entries({
    'cache hits': seen.cacheHits,
    fallbacks: seen.fallbacks,
    '429 rate limit': seen.s429,
    '402 budget': seen.s402,
  })
    .filter(([, n]) => n === 0)
    .map(([k]) => k);
  if (missing.length) {
    log(`✖ not observed: ${missing.join(', ')}`);
    process.exit(1);
  }
  log('✔ observed cache hits, fallbacks, 429s and 402s');
}

main().catch((err) => {
  process.stderr.write(`✖ ${err.message}\n`);
  process.exit(1);
});
