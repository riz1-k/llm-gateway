#!/usr/bin/env node
// Summarizes a V8 .cpuprofile (from `node --cpu-prof`) by self time per function and per
// package/module, to find request-path hot spots.
//   node bench/profile-top.mjs /tmp/prof/gateway-on.cpuprofile [top=25]
import { readFileSync } from 'node:fs';

const [file, topArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: profile-top.mjs <file.cpuprofile> [top]');
  process.exit(1);
}
const top = Number(topArg ?? 25);
const profile = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = new Map();
// timeDeltas[i] is the time since the previous sample; attribute it to samples[i]
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
}
const total = [...dt.values()].reduce((a, b) => a + b, 0);

const moduleOf = (url) => {
  if (!url) return '(native/vm)';
  const nm = url.lastIndexOf('node_modules/');
  if (nm >= 0) {
    const rest = url.slice(nm + 'node_modules/'.length).split('/');
    return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  }
  if (url.startsWith('node:')) return url;
  const m = url.match(/\/(dist|src)\/(.*)$/);
  return m ? `switchyard:${m[2]}` : url;
};

const fns = new Map();
const mods = new Map();
for (const [id, t] of dt) {
  const n = byId.get(id);
  const cf = n.callFrame;
  const name = cf.functionName || '(anonymous)';
  const key = `${name}  ${moduleOf(cf.url)}:${cf.lineNumber + 1}`;
  fns.set(key, (fns.get(key) ?? 0) + t);
  const mod = ['(idle)', '(program)', '(garbage collector)'].includes(name)
    ? name
    : moduleOf(cf.url);
  mods.set(mod, (mods.get(mod) ?? 0) + t);
}
const pct = (t) => `${((t / total) * 100).toFixed(1).padStart(5)} %`;
const busy = total - (mods.get('(idle)') ?? 0);
console.log(
  `total ${(total / 1000).toFixed(0)} ms sampled, busy ${(busy / 1000).toFixed(0)} ms (${pct(busy)})\n`,
);
console.log('self time by module:');
for (const [k, t] of [...mods].sort((a, b) => b[1] - a[1]).slice(0, top))
  console.log(`  ${pct(t)}  ${k}`);
console.log('\nself time by function:');
for (const [k, t] of [...fns].sort((a, b) => b[1] - a[1]).slice(0, top))
  console.log(`  ${pct(t)}  ${k}`);
