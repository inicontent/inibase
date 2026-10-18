// Fault injection around rebuildable scratch after a durable append.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const source = resolve(process.argv[2]);
const { TableOverlay } = await import(pathToFileURL(join(source, 'overlay.js')));
const { resourcesFor } = await import(pathToFileURL(join(source, 'resources.js')));
const root = await mkdtemp(join(tmpdir(),'overlay-cursor-repro-'));
const table = join(root,'records'); await mkdir(table);
const overlay = new TableOverlay(table,0);
try {
 await overlay.refreshForWrite();
 const frame = (gen,value) => ({gen, records:[{id:1,cols:{value},updatedAt:gen}]});
 const initial=frame(1,'old'); await overlay.log.append(initial); await overlay.applyLocal([initial]);
 const next=frame(2,'durable'); await overlay.log.append(next);
 const original=overlay.byId.set.bind(overlay.byId);
 overlay.byId.set=async()=>{throw new Error('injected scratch failure');};
 await assert.rejects(overlay.applyLocal([next]),/injected scratch failure/);
 overlay.byId.set=original; await overlay.refresh();
 const recovered=(await overlay.get(1))?.cols.value;
 console.log(JSON.stringify({source,recovered,committedGen:overlay.committedGen,expected:'durable'}));
 assert.equal(recovered,'durable'); assert.equal(overlay.committedGen,2);
} finally {await overlay.dispose();await resourcesFor(root).close();await rm(root,{recursive:true,force:true});}
