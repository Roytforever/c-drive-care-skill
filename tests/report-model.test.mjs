import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportModel, safeReportExport, resolveTreeAction, migrationProposal, validateReportState, summarizeCacheCandidates, compareSnapshots } from '../src/report-model.js';

const fixture=()=>({version:'2.0-static',scan:{id:'s',root:'C:\\',status:'completed',totalBytes:100,filesCount:8,directories:[
  {id:'r',parentId:null,name:'C:\\',path:'C:\\',bytes:100,ownBytes:0},
  {id:'u',parentId:'r',name:'Sample',path:'C:\\Users\\Sample',bytes:60,ownBytes:0},
  {id:'a',parentId:'u',name:'AppData',path:'C:\\Users\\Sample\\AppData',bytes:40,ownBytes:0},
  {id:'n',parentId:'a',name:'npm-cache',path:'C:\\Users\\Sample\\AppData\\Local\\npm-cache',bytes:10,ownBytes:10},
  {id:'o',parentId:'a',name:'Other',path:'C:\\Users\\Sample\\AppData\\Other',bytes:30,ownBytes:30},
  {id:'c',parentId:'u',name:'.codex',path:'C:\\Users\\Sample\\.codex',bytes:15,ownBytes:15},
  {id:'d',parentId:'u',name:'Documents',path:'C:\\Users\\Sample\\Documents',bytes:5,ownBytes:5},
  {id:'w',parentId:'r',name:'Windows',path:'C:\\Windows',bytes:40,ownBytes:40}],largeFiles:[{name:'x',path:'C:\\Users\\Sample\\AppData\\Local\\npm-cache\\x',bytes:10}]},drives:[],caches:[],history:[]});

test('aggregate, own-file and omitted-directory blocks resolve to visible actions',()=>{
  assert.deepEqual(resolveTreeAction({type:'more',items:['a','b']}),{kind:'group',items:['a','b']});
  assert.deepEqual(resolveTreeAction({type:'own',parentId:'r'}),{kind:'files',directoryId:'r'});
  assert.deepEqual(resolveTreeAction({type:'omitted',parentId:'r'}),{kind:'coverage',directoryId:'r'});
  assert.deepEqual(resolveTreeAction({id:'leaf'}),{kind:'directory',directoryId:'leaf'});
});

test('cache summary uses the same measured items as its breakdown and excludes protected or unknown sizes',()=>{
  const summary=summarizeCacheCandidates([{path:'C:\\a',bytes:5,risk:'rebuildable',eligible:true},{path:'C:\\b',bytes:8,risk:'review',eligible:true},{path:'C:\\unknown',bytes:null,risk:'review',eligible:true},{path:'C:\\Documents',bytes:100,risk:'protected',eligible:false}]);
  assert.equal(summary.totalBytes,13);assert.equal(summary.count,2);assert.equal(summary.unknownCount,1);
  assert.equal(summary.rebuildableBytes,5);assert.equal(summary.reviewBytes,8);
  assert.deepEqual(summary.items.map(item=>item.path),['C:\\a','C:\\b']);
});

test('project metadata inside user documents is not added twice to findings',()=>{
  const f={scan:{totalBytes:100,directories:[{id:'r',parentId:null,path:'C:\\',bytes:100,ownBytes:0},{id:'d',parentId:'r',path:'C:\\Users\\Sample\\Documents',bytes:100,ownBytes:80},{id:'v',parentId:'d',path:'C:\\Users\\Sample\\Documents\\project\\.vscode',bytes:20,ownBytes:20}],largeFiles:[]}};
  const m=createReportModel(f);assert.equal(m.findings.reduce((n,item)=>n+item.bytes,0),100);
});

test('a custom npm location containing documents stays protected and cannot become a cache proposal',()=>{
  const f=fixture();f.caches=[{id:'npm',name:'npm',path:'C:\\Users\\Sample\\Documents',defaultPath:'C:\\Users\\Sample\\AppData\\Local\\npm-cache',bytes:5,source:'config',supported:false}];
  const m=createReportModel(f),custom=m.candidates.find(item=>item.path.endsWith('Documents'));
  assert.equal(custom.risk,'protected');assert.equal(custom.eligible,false);
  assert.throws(()=>migrationProposal(custom,{path:'E:\\',isSystem:false}),/用途|混合/);
});

test('Yarn source cache copies into a child of the configured global folder',()=>{
  const p=migrationProposal({tool:'yarn',path:'C:\\Yarn\\Berry\\cache',name:'Yarn',bytes:3},{path:'E:\\',isSystem:false});
  assert.equal(p.target,'E:\\DevCaches\\yarn\\cache');assert.equal(p.configurationValue,'E:\\DevCaches\\yarn');
});

test('malformed imported snapshots are rejected before rendering',()=>{
  const badDirectory=fixture();badDirectory.scan.directories=[null];assert.throws(()=>validateReportState(badDirectory),/目录/);
  const f=fixture();f.scan.directories[0].parentId='n';assert.throws(()=>validateReportState(f),/根|循环/);
  assert.equal(validateReportState(fixture()),true);
  for(const update of [{drives:{}},{caches:[null]}])assert.throws(()=>validateReportState({...fixture(),...update}),/字段|记录/);
  const badCount=fixture();badCount.scan.errors={};assert.throws(()=>validateReportState(badCount),/统计/);
  const badRoot=fixture();badRoot.scan.root={};assert.throws(()=>validateReportState(badRoot),/范围/);
});

test('findings split nested cache from mixed app data without double counting',()=>{
  const m=createReportModel(fixture());
  assert.equal(m.candidates.find(x=>x.tool==='npm').bytes,10);
  assert.equal(m.findings.find(x=>x.id==='application-data').bytes,30);
  assert.equal(m.findings.reduce((sum,x)=>sum+x.bytes,0),100);
  assert.equal(m.findings.at(-1).kind,'baseline');
  assert.equal(m.candidates.some(x=>x.path.endsWith('.codex')),false);
});

test('omitted bytes remain distinct from listed children and files filter by path boundary',()=>{
  const f=fixture();f.scan.directories[0].omittedBytes=7;f.scan.largeFiles.push({name:'y',path:'C:\\Users\\Sample2\\y',bytes:1});
  const m=createReportModel(f);
  assert.equal(m.children('r').find(x=>x.type==='omitted').bytes,7);
  assert.equal(m.filesIn('C:\\Users\\Sample').length,1);
  assert.equal(m.trail('n').map(x=>x.id).join('/'),'r/u/a/n');
});

test('export strips execution credentials recursively and migration proposals never contain an execute URL',()=>{
  const clean=safeReportExport({csrfToken:'secret',plan:{confirmationText:'confirm',snapshot:{private:1}},scan:fixture().scan});
  assert.equal(JSON.stringify(clean).includes('secret'),false);assert.equal('confirmationText' in clean.plan,false);
  const proposal=migrationProposal({tool:'npm',name:'npm',path:'C:\\cache',bytes:10},{id:'E:',path:'E:\\',isSystem:false,freeBytes:1e9});
  assert.equal(proposal.source,'C:\\cache');assert.match(proposal.target,/^E:\\/);assert.equal(proposal.execution,'manual-review');assert.equal(proposal.immediateReleasedBytes,0);
  assert.equal(JSON.stringify(proposal).includes('/api/execute'),false);
  assert.throws(()=>migrationProposal({path:'C:\\cache'},{path:'C:\\',isSystem:true}),/系统/);
});


test('inventory aliases and unsupported tools remain visible with protected custom locations',()=>{
  const f=fixture();
  f.caches=[
    {id:'pnpm',path:'C:\\custom-store',defaultPath:'C:\\Users\\Sample\\AppData\\Local\\pnpm\\store',exists:true,bytes:null,source:'config'},
    {id:'gradle',path:'C:\\Users\\Sample\\.gradle\\caches',defaultPath:'C:\\Users\\Sample\\.gradle\\caches',exists:true,bytes:12},
    {id:'maven',path:'C:\\Users\\Sample\\.m2\\repository',exists:true,bytes:13},
    {id:'future-tool',path:'C:\\unknown',exists:true,bytes:7}
  ];
  const m=createReportModel(f);
  assert.equal(m.candidates.length,5);
  assert.equal(m.candidates.find(c=>c.tool==='pnpm-store').eligible,false);
  for(const tool of ['gradle','maven','future-tool'])assert.equal(m.candidates.find(c=>c.tool===tool).risk,'protected');
});

test('explicit custom inventory overrides a path that also matches a default cache rule',()=>{
  const f=fixture();
  f.caches=[{id:'pip',path:f.scan.directories[3].path,defaultPath:'C:\\Users\\Sample\\AppData\\Local\\pip\\Cache',exists:true,source:'environment'}];
  const candidate=createReportModel(f).candidates.find(c=>c.path===f.scan.directories[3].path);
  assert.equal(candidate.risk,'protected');assert.equal(candidate.eligible,false);
  assert.equal(candidate.source,'environment');
});

test('per-directory files include details outside Top500 and report honest coverage for old snapshots',()=>{
  const f=fixture();f.scan.directories[3].ownFileCount=3;
  f.scan.fileDetails=[{parentId:'n',path:f.scan.largeFiles[0].path,name:'x',bytes:10},{parentId:'n',path:f.scan.directories[3].path+'\\small.txt',name:'small.txt',bytes:1}];
  const m=createReportModel(f);
  assert.equal(m.files.length,1);assert.equal(m.filesIn(f.scan.directories[3].path,true).length,2);
  assert.deepEqual({...m.fileCoverage('n'),coverage:undefined},{retained:2,total:3,limited:true,legacy:false,coverage:undefined});
  const legacy=createReportModel(fixture()).fileCoverage('n');
  assert.equal(legacy.total,null);assert.equal(legacy.legacy,true);assert.equal(legacy.limited,true);
});

test('directory search is bounded, excludes root and supports case-insensitive literal paths',()=>{
  const m=createReportModel(fixture());
  const first=m.getDirectoryRows('',2);assert.equal(first.items.length,2);assert.equal(first.total,7);assert.equal(first.hasMore,true);
  assert.equal(first.items[0].id,'u');
  const result=m.getDirectoryRows('APPDATA',80);assert.equal(result.total,3);assert.equal(result.hasMore,false);
  assert.equal(m.getDirectoryRows('does-not-exist',80).total,0);
});

test('new file detail and coverage fields reject malformed imported snapshots',()=>{
  const f=fixture();f.scan.fileDetails=[{parentId:'missing',path:'C:\\bad',bytes:1}];
  assert.throws(()=>validateReportState(f),/文件|父/);
  const bad=fixture();bad.scan.directories[0].ownFileCount=-1;assert.throws(()=>validateReportState(bad),/目录|数量|计数/);
  const coverage=fixture();coverage.scan.directories[0].coverage={status:'complete',errors:-1,skipped:0};assert.throws(()=>validateReportState(coverage),/覆盖|计数/);
});

test('snapshot comparisons require equal roots and measurements and retain completeness warnings',()=>{
  const before=fixture(),after=fixture();before.scan.finishedAt='2024-01-01';after.scan.finishedAt='2024-01-02';
  before.scan.complete=true;after.scan.complete=false;after.scan.directories[3].bytes=30;
  const result=compareSnapshots(before,after);
  assert.equal(result.compatible,true);assert.equal(result.partial,true);assert.equal(result.previousAt,'2024-01-01');
  assert.equal(result.changes.find(x=>x.path===after.scan.directories[3].path).deltaBytes,20);
  const other=fixture();other.scan.root='E:\\';assert.equal(compareSnapshots(before,other).compatible,false);
  other.scan.root=before.scan.root;other.scan.measurement='allocated-bytes';assert.equal(compareSnapshots(before,other).compatible,false);
});

test('ordinary recommendations use evidence and keep mixed application data out of cleanup claims',()=>{
  const m=createReportModel(fixture());
  assert.deepEqual(m.recommendations.map(r=>r.id),['check','official','relocate','keep']);
  const check=m.recommendations.find(r=>r.id==='check');assert.ok(check.items.every(row=>!row.path.endsWith('AppData')));
  assert.match(m.recommendations.find(r=>r.id==='keep').description,/保留|保护/);
});


test('building a homepage model does not eagerly filter and sort the entire directory list',()=>{
  const f=fixture();let calls=0;
  f.scan.directories.filter=function(...args){calls++;return Array.prototype.filter.apply(this,args);};
  const m=createReportModel(f);
  assert.equal(calls,0);
  m.getDirectoryRows('',80);assert.equal(calls,1);
  m.getDirectoryRows('appdata',80);m.getDirectoryRows('windows',80);assert.equal(calls,1);
});

test('nested cache records stay visible but their summary does not double count parent bytes',()=>{
  const f=fixture();f.scan.directories.push({id:'nested',parentId:'n',path:f.scan.directories[3].path+'\\nested',bytes:2,ownBytes:2});
  f.caches=[{id:'npm',path:f.scan.directories[3].path,defaultPath:f.scan.directories[3].path,exists:true},{id:'pip',path:f.scan.directories.at(-1).path,defaultPath:f.scan.directories.at(-1).path,exists:true}];
  const m=createReportModel(f);assert.equal(m.candidates.length,2);assert.equal(m.cacheSummary.totalBytes,10);
});


test('unknown inventory existence stays unknown and cannot be selected for planning',()=>{
  for(const exists of [null,undefined]){
    const f=fixture();
    const path='C:\\Users\\Sample\\AppData\\Local\\pip\\Cache';
    f.caches=[{id:'pip',path,defaultPath:path,exists,bytes:200,source:'default'}];
    const model=createReportModel(f),candidate=model.candidates.find(item=>item.tool==='pip');
    assert.equal(candidate.exists,null);assert.equal(candidate.eligible,false);assert.equal(candidate.bytes,null);
    assert.equal(model.cacheSummary.totalBytes,10);
    assert.throws(()=>migrationProposal(candidate,{path:'E:\\',isSystem:false}),/用途|混合|核验/);
  }
  const f=fixture();f.caches=[{id:'npm',path:f.scan.directories[3].path,defaultPath:f.scan.directories[3].path,exists:null}];
  const candidate=createReportModel(f).candidates.find(item=>item.tool==='npm');
  assert.equal(candidate.exists,true);assert.equal(candidate.eligible,true);assert.equal(candidate.bytes,10);
});
