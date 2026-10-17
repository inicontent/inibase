// Isolated, deterministic scratch-overlay diagnostic; not durable-write throughput.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const moduleDirectory = resolve(process.argv[2] ?? 'dist');
const { DiskOverlay } = await import(pathToFileURL(join(moduleDirectory, 'disk-overlay.js')));
const { DatabaseResources } = await import(pathToFileURL(join(moduleDirectory, 'resources.js')));
const root = await mkdtemp(join(tmpdir(), 'overlay-churn-'));
const resources = new DatabaseResources();
const overlay = new DiskOverlay(root, resources);
const count = 256, rounds = 16;
const startUsage = process.resourceUsage();
try {
 const start = performance.now();
 for (let round = 0; round < rounds; round++) for (let id = 1; id <= count; id++)
  await overlay.set(id, {cols: {value: `${round}:` + 'x'.repeat(1024)}});
 const writesMs = performance.now() - start;
 const samples = [];
 for (let run = 0; run < 20; run++) {
  const start = performance.now(); let seen = 0;
  for await (const [id, value] of overlay.entries()) {
   assert.equal(value.cols.value, '15:' + 'x'.repeat(1024));
   assert.ok(Number(id) >= 1 && Number(id) <= count); seen++;
  }
  assert.equal(seen, count); samples.push(performance.now() - start);
 }
 console.log(JSON.stringify({moduleDirectory, count, rounds, writesMs, scanMs:samples,
  resources: resources.stats(), startUsage, endUsage:process.resourceUsage()}, null, 2));
} finally { await overlay.clear(); await resources.close(); await rm(root, {recursive:true, force:true}); }
