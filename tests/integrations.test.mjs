import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient, normalizeBaseUrl, toolDefinitions } from '../integrations/client.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../integrations/cli.mjs', import.meta.url));
const mcp = fileURLToPath(new URL('../integrations/mcp.mjs', import.meta.url));

async function fixture(t) {
  const requests = [];
  const secret = 'fixture-private-session-token';
  const state = { version: '1.0.0', platform: 'win32', csrfToken: secret, drives: [{ id: 'C:', totalBytes: 1000, freeBytes: 300 }],
    caches: [{ id: 'npm', path: 'C:\\fixture\\npm-cache', bytes: 45, supported: true }],
    scan: { status: 'completed', root: 'C:\\fixture', filesCount: 3, totalBytes: 123, complete: true, errors: 0, skipped: 0,
      largeFiles: [{ path: 'C:\\fixture\\one', bytes: 70 }, { path: 'C:\\fixture\\two', bytes: 40 }, { path: 'C:\\fixture\\three', bytes: 13 }], directories: [{ id: 'root', path: 'C:\\fixture', bytes: 123, ownBytes: 3 }, { id: 'one', parentId: 'root', path: 'C:\\fixture\\big', bytes: 100, ownBytes: 20 }, { id: 'two', parentId: 'root', path: 'C:\\fixture\\small', bytes: 20, ownBytes: 20 }] },
    operations: [], history: [], plans: [] };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, token: req.headers['x-liubai-token'], body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/state') return res.end(JSON.stringify(state));
    if (req.headers['x-liubai-token'] !== secret) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'bad token' })); }
    if (req.url === '/api/scan') return res.end(JSON.stringify({ ...state.scan, status: 'running' }));
    if (req.url === '/api/scan/cancel') return res.end(JSON.stringify({ ...state.scan, status: 'cancelled' }));
    if (req.url === '/api/plans') return res.end(JSON.stringify({ id: 'plan-1', kind: JSON.parse(body).kind, source: 'C:\\fixture\\npm-cache', target: 'E:\\cache', bytes: 45, confirmationText: '迁移 npm', csrfToken: secret }));
    res.statusCode = 404; res.end(JSON.stringify({ error: 'unknown endpoint' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, state, secret };
}

test('rejects remote, credentialed, path-bearing and disguised loopback service URLs', () => {
  for (const url of ['https://example.com', 'http://example.com', 'http://localhost.evil.test:4317', 'http://user@localhost:4317', 'http://127.0.0.1:4317/api', 'http://2130706433:4317', 'http://127.1:4317', 'http://localhost:4317?x=1', 'file:///tmp/service']) {
    assert.throws(() => normalizeBaseUrl(url));
  }
  assert.equal(normalizeBaseUrl('http://localhost:4317/'), 'http://127.0.0.1:4317');
});

test('status and paginated files omit credentials and bulk directory index', async t => {
  const f = await fixture(t);
  const client = createClient({ baseUrl: f.baseUrl });
  const status = await client.callTool('liubai_status', {});
  assert.equal(status.scan.totalBytes, 123);
  assert.equal('directories' in status.scan, false);
  assert.equal(status.topDirectories[0].path, 'C:\\fixture\\big');
  assert.equal(status.topDirectories[0].bytes, 100);
  assert.equal(status.topDirectories.some(d => d.id === 'root'), false);
  assert.equal(JSON.stringify(status).includes(f.secret), false);
  const files = await client.callTool('liubai_files', { offset: 1, limit: 1 });
  assert.equal(files.items[0].bytes, 40);
  assert.equal(files.nextOffset, 2);
  assert.equal(files.total, 3);
  await assert.rejects(() => client.callTool('liubai_files', { limit: 10000 }));
});

test('planning obtains an internal token but exposes no execute or reveal capability', async t => {
  const f = await fixture(t);
  const client = createClient({ baseUrl: f.baseUrl });
  const plan = await client.callTool('liubai_plan', { kind: 'migrate', cacheId: 'npm', driveId: 'E:' });
  assert.equal(plan.plan.id, 'plan-1');
  assert.equal(plan.requiresHumanConfirmation, true);
  assert.equal(plan.uiUrl, f.baseUrl + '/');
  assert.equal(JSON.stringify(plan).includes(f.secret), false);
  assert.equal('confirmationText' in plan.plan, false);
  assert.equal(f.requests.at(-1).path, '/api/plans');
  assert.equal(f.requests.at(-1).token, f.secret);
  await assert.rejects(() => client.callTool('liubai_execute', { planId: 'plan-1' }));
  await assert.rejects(() => client.callTool('liubai_plan', { kind: 'migrate', cacheId: 'npm', driveId: 'E:', execute: true }));
  assert.equal(toolDefinitions.some(tool => /execute|reveal|delete/.test(tool.name)), false);
  assert.equal(f.requests.some(req => ['/api/execute', '/api/reveal'].includes(req.path)), false);
});

test('CLI prints machine-readable JSON and forwards explicit scan path unchanged', async t => {
  const f = await fixture(t);
  const env = { ...process.env, LIUBAI_URL: f.baseUrl };
  const { stdout, stderr } = await run(process.execPath, [cli, 'scan', '--root', 'C:\\fixture'], { env, windowsHide: true });
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).scan.status, 'running');
  assert.deepEqual(f.requests.at(-1).body, { root: 'C:\\fixture' });
  const files = await run(process.execPath, [cli, 'files', '--limit', '1', '--offset', '2'], { env, windowsHide: true });
  assert.equal(JSON.parse(files.stdout).items[0].bytes, 13);
  await assert.rejects(() => run(process.execPath, [cli, 'execute', '--planId', 'plan-1'], { env, windowsHide: true }));
});

test('stdio MCP negotiates lifecycle, exposes bounded tools and returns valid protocol-only lines', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [mcp], { env: { ...process.env, LIUBAI_URL: f.baseUrl }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stderr = '', buffer = '';
  const waiting = new Map();
  child.stderr.on('data', value => { stderr += value; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
      waiting.get(message.id)?.(message); waiting.delete(message.id);
    }
  });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    const timeout = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 5000);
    waiting.set(current, message => { clearTimeout(timeout); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n');
  });
  const premature = await request('tools/list');
  assert.ok(premature.error);
  const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.ok(init.result.capabilities.tools);
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const list = await request('tools/list');
  assert.ok(list.result.tools.find(tool => tool.name === 'liubai_status'));
  assert.ok(list.result.tools.find(tool => tool.name === 'liubai_report'));
  const ping = await request('ping'); assert.deepEqual(ping.result, {});
  const status = await request('tools/call', { name: 'liubai_status', arguments: {} });
  assert.equal(status.result.isError, false);
  assert.equal(JSON.parse(status.result.content[0].text).scan.totalBytes, 123);
  assert.equal(JSON.stringify(status).includes(f.secret), false);
  const reportInput=await reportFixture(t),requestCount=f.requests.length;
  const report=await request('tools/call',{name:'liubai_report',arguments:{index:reportInput.input,reportOnly:true,outDir:path.join(reportInput.root,'mcp report')}});
  assert.equal(report.result.isError,false);
  assert.equal(report.result.structuredContent.static,true);
  assert.equal(report.result.structuredContent.requiresLocalService,false);
  assert.equal(f.requests.length,requestCount);
  const invalid = await request('tools/call', { name: 'liubai_execute', arguments: {} });
  assert.ok(invalid.error);
  assert.equal(stderr, '');
  child.stdin.end();
  await new Promise(resolve => child.once('exit', resolve));
});

test('bridge does not follow redirects to other hosts', async t => {
  const server = http.createServer((req, res) => { res.writeHead(302, { location: 'http://example.com/steal' }); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const client = createClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(() => client.callTool('liubai_status', {}), /redirect|重定向/i);
});

async function reportFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'liubai-report-bridge-'));
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
  const input=path.join(root,'old snapshot.json');
  const scan={id:'old-report',status:'completed',root:'C:\\fixture',startedAt:'2024-01-02T00:00:00Z',finishedAt:'2024-01-02T00:01:00Z',filesCount:1,dirsCount:1,totalBytes:7,errors:0,skipped:0,complete:true,directories:[{id:'root',parentId:null,path:'C:\\fixture',name:'fixture',bytes:7,ownBytes:7}],largeFiles:[{path:'C:\\fixture\\one',name:'one',bytes:7}]};
  await fs.writeFile(input,JSON.stringify({scan,csrfToken:'never embed this',drives:[],caches:[]}));
  return {root,input,scan};
}

test('static report tool creates a standalone artifact without contacting the live service',async t=>{
  const f=await fixture(t),r=await reportFixture(t);
  const result=await createClient({baseUrl:f.baseUrl}).callTool('liubai_report',{index:r.input,reportOnly:true,outDir:path.join(r.root,'report output')});
  assert.equal(result.status,'completed');assert.match(result.fileUri,/^file:\/\//);
  assert.equal(result.sourceMode,'snapshot');assert.equal(f.requests.length,0);
  const html=await fs.readFile(result.report,'utf8');assert.ok(html.includes('liubai-report-data'));assert.ok(!html.includes('never embed this'));
  const inspectScript = `from html.parser import HTMLParser
import json,sys
class Inspector(HTMLParser):
    def __init__(self):
        super().__init__(); self.external=[]
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if (tag=='script' and a.get('src')) or (tag=='link' and a.get('rel')=='stylesheet' and a.get('href')): self.external.append(a)
p=Inspector();p.feed(open(sys.argv[1],encoding='utf-8').read());print(json.dumps(p.external))`;
  const inspected=await run('python',['-c',inspectScript,result.report],{windowsHide:true,encoding:'utf8'});
  assert.deepEqual(JSON.parse(inspected.stdout),[]);
  assert.equal(JSON.parse(await fs.readFile(result.index,'utf8')).scan.finishedAt,r.scan.finishedAt);
  await assert.rejects(()=>createClient({baseUrl:f.baseUrl}).callTool('liubai_report',{reportOnly:true}),/index|索引/);
  await assert.rejects(()=>createClient({baseUrl:f.baseUrl}).callTool('liubai_report',{index:r.input,reportOnly:'true'}),/boolean|布尔|reportOnly/);
  await assert.rejects(()=>createClient({baseUrl:f.baseUrl}).callTool('liubai_report',{root:'\\\\server\\share'}),/本地|网络|绝对/);
});

test('CLI report parses booleans and works with no HTTP service configuration',async t=>{
  const r=await reportFixture(t),out=path.join(r.root,'cli report');
  const result=await run(process.execPath,[cli,'report','--index',r.input,'--reportOnly','true','--outDir',out],{env:{...process.env,LIUBAI_URL:'http://not-a-local-service.invalid'},windowsHide:true});
  const summary=JSON.parse(result.stdout);assert.equal(summary.sourceMode,'snapshot');assert.equal(summary.filesCount,1);
  assert.ok(await fs.stat(path.join(out,'report.html')));
  await fs.writeFile(path.join(out,'report.html'),'previous report');
  const refreshed=await run(process.execPath,[cli,'report','--index',r.input,'--reportOnly','true','--outDir',out,'--overwrite','true'],{windowsHide:true});
  assert.equal(JSON.parse(refreshed.stdout).status,'completed');
  assert.match(await fs.readFile(path.join(out,'report.html'),'utf8'),/liubai-report-data/);
});

test('static report bridge protects existing outputs unless overwrite is explicitly requested',async t=>{
  const r=await reportFixture(t),out=path.join(r.root,'protected output');
  const client=createClient();
  const input={index:r.input,reportOnly:true,outDir:out};
  await client.callTool('liubai_report',input);
  const html=path.join(out,'report.html');await fs.writeFile(html,'existing user content');
  await assert.rejects(()=>client.callTool('liubai_report',input),/存在|覆盖/);
  assert.equal(await fs.readFile(html,'utf8'),'existing user content');
  await client.callTool('liubai_report',{...input,overwrite:true});
  assert.match(await fs.readFile(html,'utf8'),/liubai-report-data/);
  await assert.rejects(()=>client.callTool('liubai_report',{...input,overwrite:'true'}),/overwrite|布尔/);
});
