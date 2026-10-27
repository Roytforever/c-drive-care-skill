import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportModel, safeReportExport, resolveTreeAction, migrationProposal, validateReportState, summarizeCacheCandidates } from '../src/report-model.js';

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
