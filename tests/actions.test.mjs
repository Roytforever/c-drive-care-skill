import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createActionManager } from '../server/actions.mjs';
import { inside } from '../server/safety.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'liubai-actions-'));
  const source = path.join(root, 'npm-cache');
  const targetRoot = path.join(root, 'disk');
  await fs.mkdir(source); await fs.mkdir(targetRoot);
  await fs.writeFile(path.join(source, 'one'), 'cache content');
  const values = new Map();
  const inventory = {drives:[{id:'target',path:targetRoot,freeBytes:1e12,isSystem:false}],caches:[{id:'npm',name:'npm',path:source,exists:true,supported:true,envKey:'NPM_CONFIG_CACHE'}]};
  const manager = await createActionManager({stateDir:path.join(root,'state'),getInventory:async()=>inventory,allowedRoots:{npm:source},systemRoot:path.join(root,'system'),config:{read:async key=>values.get(key)??null,write:async(key,value)=>value===null?values.delete(key):values.set(key,value)}});
  t.after(async()=>{await manager.waitForIdle();const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(resolved,{recursive:true,force:true});});
  const execute = async plan=>{const result=await manager.execute({planId:plan.id,confirmationText:plan.confirmationText,acknowledged:true});await manager.waitForIdle();return manager.getState().operations.find(x=>x.id===result.operationId);};
  return {root,source,targetRoot,manager,values,inventory,execute};
}

test('confirmation is mandatory, one-use, and copying preserves source bytes', async t=>{
  const f=await fixture(t);const plan=await f.manager.plan({kind:'migrate',cacheId:'npm',driveId:'target'});
  await assert.rejects(f.manager.execute({planId:plan.id,confirmationText:plan.confirmationText}),/确认/);
  const operation=await f.execute(plan);assert.equal(operation.status,'completed');
  assert.equal(await fs.readFile(path.join(f.source,'one'),'utf8'),'cache content');
  assert.equal(await fs.readFile(path.join(plan.target,'one'),'utf8'),'cache content');
  assert.equal(f.values.get('NPM_CONFIG_CACHE'),plan.target);
  await assert.rejects(f.execute(plan),/失效|已使用/);
});

test('changed source after review cannot be isolated', async t=>{
  const f=await fixture(t);const plan=await f.manager.plan({kind:'isolate',cacheId:'npm'});
  await fs.writeFile(path.join(f.source,'one'),'changed');
  const result=await f.execute(plan);assert.equal(result.status,'failed');
  assert.match(result.error,/变化|改变/);assert.ok(await fs.stat(f.source));
});

test('isolation releases no space and restoration refuses an occupied original path',async t=>{
  const f=await fixture(t);const plan=await f.manager.plan({kind:'isolate',cacheId:'npm'});
  const result=await f.execute(plan);assert.equal(result.status,'completed');assert.equal(result.releasedBytes,0);
  await assert.rejects(fs.stat(f.source),/ENOENT/);
  assert.equal(await fs.readFile(path.join(result.target,'one'),'utf8'),'cache content');
  await fs.mkdir(f.source);await fs.writeFile(path.join(f.source,'new'),'new data');
  await assert.rejects(f.manager.plan({kind:'restore',operationId:result.id}),/存在|占用/);
  await fs.unlink(path.join(f.source,'new'));await fs.rmdir(f.source);
  const restore=await f.manager.plan({kind:'restore',operationId:result.id});
  assert.equal((await f.execute(restore)).status,'completed');
  assert.equal(await fs.readFile(path.join(f.source,'one'),'utf8'),'cache content');
});

test('untrusted cache roots and system targets cannot be selected',async t=>{
  const f=await fixture(t);f.inventory.caches[0].path=f.root;
  await assert.rejects(f.manager.plan({kind:'isolate',cacheId:'npm'}),/允许|支持|路径/);
  f.inventory.caches[0].path=f.source;f.inventory.drives[0].isSystem=true;
  await assert.rejects(f.manager.plan({kind:'migrate',cacheId:'npm',driveId:'target'}),/系统盘/);
});

test('junction content is rejected without following it',async t=>{
  const f=await fixture(t);await fs.symlink(f.targetRoot,path.join(f.source,'link'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.manager.plan({kind:'isolate',cacheId:'npm'}),/链接|重解析/);
});

test('rollback restores only the previous environment setting and retains both copies',async t=>{
  const f=await fixture(t);f.values.set('NPM_CONFIG_CACHE','old-config');
  const plan=await f.manager.plan({kind:'migrate',cacheId:'npm',driveId:'target'});const result=await f.execute(plan);
  const rollback=await f.manager.plan({kind:'rollback',operationId:result.id});assert.equal((await f.execute(rollback)).status,'completed');
  assert.equal(f.values.get('NPM_CONFIG_CACHE'),'old-config');assert.ok(await fs.stat(plan.target));assert.ok(await fs.stat(f.source));
});

test('journals survive restart and actions never overwrite target content',async t=>{
  const f=await fixture(t);const plan=await f.manager.plan({kind:'migrate',cacheId:'npm',driveId:'target'});
  await fs.mkdir(plan.target,{recursive:true});await fs.writeFile(path.join(plan.target,'sentinel'),'keep');
  assert.equal((await f.execute(plan)).status,'failed');assert.equal(await fs.readFile(path.join(plan.target,'sentinel'),'utf8'),'keep');
  const state=JSON.parse(await fs.readFile(path.join(f.root,'state','journal.json'),'utf8'));assert.equal(state.operations.length,1);
});

test('drive root containment accepts child paths without accepting sibling names',()=>{
  assert.equal(inside(path.join(path.parse(process.cwd()).root,'LiubaiCaches','npm'),path.parse(process.cwd()).root),true);
  assert.equal(inside(path.join(os.tmpdir(),'cache-other'),path.join(os.tmpdir(),'cache')),false);
});

test('concurrent history writes preserve all durable entries',async t=>{
  const f=await fixture(t);
  await Promise.all(Array.from({length:12},(_,i)=>f.manager.addHistory('entry '+i,'fixture')));
  const journal=JSON.parse(await fs.readFile(path.join(f.root,'state','journal.json'),'utf8'));
  assert.equal(journal.history.length,12);
});

test('Windows named streams are rejected instead of omitted from copy verification',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.source,'one:private'),'private stream');
  await assert.rejects(f.manager.plan({kind:'migrate',cacheId:'npm',driveId:'target'}),/数据流/);
});

test('an environment edit made during copy preparation is not overwritten',async t=>{
  const f=await fixture(t);const drives=f.inventory.drives;let reads=0;
  Object.defineProperty(f.inventory,'drives',{get(){if(++reads===2)f.values.set('NPM_CONFIG_CACHE','user changed this');return drives;}});
  const plan=await f.manager.plan({kind:'migrate',cacheId:'npm',driveId:'target'});
  const operation=await f.execute(plan);assert.equal(operation.status,'failed');assert.equal(f.values.get('NPM_CONFIG_CACHE'),'user changed this');
  assert.ok(await fs.stat(f.source));assert.ok(await fs.stat(plan.target));
});
