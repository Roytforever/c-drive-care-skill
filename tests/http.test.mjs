import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createService } from '../server/service.mjs';

test('local API rejects cross-origin access, missing tokens, and arbitrary reveal paths',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'liubai-http-'));
  const service=await createService({stateDir:root,getInventory:async()=>({drives:[],caches:[]}),allowedRoots:{}});
  await service.listen(0);const base=`http://127.0.0.1:${service.server.address().port}`;
  t.after(async()=>{await service.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
  const state=await(await fetch(base+'/api/state')).json();assert.ok(state.csrfToken);assert.equal(state.scan.status,'idle');
  assert.equal((await fetch(base+'/api/state',{headers:{Origin:'https://evil.example'}})).status,403);
  const badHost=await new Promise((resolve,reject)=>{const request=http.get(base+'/api/state',{headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});
  assert.equal(badHost,403);
  assert.equal((await fetch(base+'/api/scan',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/reveal',{method:'POST',headers:{'content-type':'application/json','X-Liubai-Token':state.csrfToken},body:JSON.stringify({path:'C:\\Windows'})})).status,400);
  assert.equal((await fetch(base+'/api/execute',{method:'POST',headers:{'content-type':'application/json','X-Liubai-Token':state.csrfToken},body:JSON.stringify({planId:'fabricated',acknowledged:true})})).status,400);
  assert.equal((await fetch(base+'/api/health')).status,200);
});

test('scanner state is real and survives service restart',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'liubai-service-'));const input=path.join(root,'input');await fs.mkdir(input);await fs.writeFile(path.join(input,'real.txt'),'actual bytes');
  const options={stateDir:path.join(root,'state'),getInventory:async()=>({drives:[],caches:[]}),allowedRoots:{}};
  let service=await createService(options);await service.listen(0);let base=`http://127.0.0.1:${service.server.address().port}`;
  t.after(async()=>{await service.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
  const bootstrap=await(await fetch(base+'/api/state')).json();
  const response=await fetch(base+'/api/scan',{method:'POST',headers:{'content-type':'application/json','X-Liubai-Token':bootstrap.csrfToken},body:JSON.stringify({root:input})});assert.equal(response.status,200);
  let state;
  for(let i=0;i<100;i++){state=await(await fetch(base+'/api/state')).json();if(state.scan.status!=='running')break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(state.scan.status,'completed');assert.equal(state.scan.totalBytes,12);assert.equal(state.scan.largeFiles[0].name,'real.txt');
  await service.close();service=await createService(options);await service.listen(0);base=`http://127.0.0.1:${service.server.address().port}`;
  state=await(await fetch(base+'/api/state')).json();assert.equal(state.scan.totalBytes,12);assert.equal(state.scan.status,'completed');
});
