import { LuaScript } from '../platform/lua.js';

/**
 * Sliding-window counters (SPEC §8).
 *
 * Each limit (scope × kind, e.g. key:rpm) is one hash `{w, c, p}`: the index of the current
 * fixed window `w`, its count `c` and the previous window's count `p`. The sliding estimate is
 *
 *     estimate = p × (W − elapsed) / W + c
 *
 * which is the classic "sliding window counter" (O(1) memory per limit, ≤ a few % error versus
 * a true sliding log). Window roll-over happens lazily when a hash is touched.
 *
 * CHECK is all-or-nothing: every limit is evaluated first and counters are incremented only if
 * all of them pass, atomically in one EVALSHA, so N concurrent requests can never overshoot.
 *
 * KEYS[i]          limit hash
 * ARGV[1]          now in ms ('' → Redis server TIME, so replicas share one clock)
 * ARGV[2]          window length W in ms
 * ARGV[3]          number of limits n
 * ARGV[2+2i]       limit i (max units per window)
 * ARGV[3+2i]       cost i (1 for rpm; the pre-flight token estimate for tpm)
 *
 * Reply: {allowed, now, window, (remaining_i, reset_ms_i, retry_after_ms_i) × n}
 *   remaining   units left after this request (floor, ≥ 0)
 *   reset_ms    time until the counter would be fully replenished without further traffic
 *   retry_ms    time until this request would fit (-1 if it can never fit: cost > limit)
 */
export const RATE_CHECK = new LuaScript(
  'ratelimit_check',
  `
local now = tonumber(ARGV[1])
if not now then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local W = tonumber(ARGV[2])
local n = tonumber(ARGV[3])
local w = math.floor(now / W)
local elapsed = now - w * W
local weight = (W - elapsed) / W

local allowed = 1
local st = {}
for i = 1, n do
  local limit = tonumber(ARGV[2 + 2 * i])
  local cost = tonumber(ARGV[3 + 2 * i])
  local h = redis.call('HMGET', KEYS[i], 'w', 'c', 'p')
  local sw = tonumber(h[1])
  local c = tonumber(h[2]) or 0
  local p = tonumber(h[3]) or 0
  if sw == nil then
    c = 0; p = 0
  elseif sw == w then
    -- same window
  elseif sw == w - 1 then
    p = c; c = 0
  else
    p = 0; c = 0
  end
  local est = p * weight + c
  if est + cost > limit then allowed = 0 end
  st[i] = { c, p, limit, cost, est }
end

local out = { allowed, now, w }
for i = 1, n do
  local c, p, limit, cost, est = st[i][1], st[i][2], st[i][3], st[i][4], st[i][5]
  local retry = 0
  if allowed == 1 then
    c = c + cost
    est = est + cost
    redis.call('HSET', KEYS[i], 'w', w, 'c', c, 'p', p)
    redis.call('PEXPIRE', KEYS[i], 2 * W)
  elseif est + cost > limit then
    if cost > limit then
      retry = -1
    elseif c + cost <= limit then
      -- wait for the previous window's weight to decay enough
      local e = W * (1 - (limit - c - cost) / p)
      retry = math.ceil(e - elapsed)
    else
      -- wait into the next window, where the current count becomes the decaying one
      local e = 0
      if c > 0 then e = W * (1 - (limit - cost) / c) end
      if e < 0 then e = 0 end
      retry = math.ceil((W - elapsed) + e)
    end
    if retry ~= -1 and retry < 1 then retry = 1 end
  end
  local remaining = limit - est
  if remaining < 0 then remaining = 0 end
  local reset = 0
  if c > 0 then reset = (W - elapsed) + W elseif p > 0 then reset = W - elapsed end
  out[#out + 1] = math.floor(remaining)
  out[#out + 1] = math.ceil(reset)
  out[#out + 1] = retry
end
return out
`,
);

/**
 * Reconciles TPM reservations: adds (actual − estimate) to the window the reservation was made
 * in (current or, if the window rolled over since, previous), never below zero. Windows older
 * than that have already decayed out of the estimate and are left alone.
 *
 * KEYS[i] tpm limit hash · ARGV[1] reservation window index · ARGV[2] delta (may be negative)
 */
export const RATE_RECONCILE = new LuaScript(
  'ratelimit_reconcile',
  `
local rw = tonumber(ARGV[1])
local delta = tonumber(ARGV[2])
for i = 1, #KEYS do
  local h = redis.call('HMGET', KEYS[i], 'w', 'c', 'p')
  local sw = tonumber(h[1])
  if sw == rw then
    local c = (tonumber(h[2]) or 0) + delta
    if c < 0 then c = 0 end
    redis.call('HSET', KEYS[i], 'c', c)
  elseif sw == rw + 1 then
    local p = (tonumber(h[3]) or 0) + delta
    if p < 0 then p = 0 end
    redis.call('HSET', KEYS[i], 'p', p)
  end
end
return 1
`,
);
