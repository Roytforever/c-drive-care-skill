import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryChildren, formatBytes, exportSnapshot } from '../src/ui-model.js';

test('directory children include direct files without counting descendant bytes twice', () => {
  const rows = [{id:'r',parentId:null,path:'C:\\',bytes:100,ownBytes:10},{id:'a',parentId:'r',path:'C:\\a',name:'a',bytes:90,ownBytes:20},{id:'b',parentId:'a',path:'C:\\a\\b',bytes:70,ownBytes:70}];
  const children = directoryChildren(rows, 'r');
  assert.equal(children.length, 2);
  assert.equal(children.reduce((sum, item) => sum + item.bytes, 0), 100);
  assert.equal(children.find(item=>item.synthetic).bytes, 10);
  assert.equal(children.some(item=>item.id==='b'), false);
});

test('report export does not disclose the session token', () => {
  const result = exportSnapshot({csrfToken:'secret',version:'1',drives:[],scan:{status:'completed'},caches:[],history:[],operations:[]});
  assert.equal('csrfToken' in result, false);
  assert.equal(result.scan.status, 'completed');
  assert.equal(result.scope, '本机磁盘分析报告；文件路径可能包含个人信息');
});

test('unknown and zero byte sizes stay distinct', () => {
  assert.equal(formatBytes(null), '未统计');
  assert.equal(formatBytes(undefined), '未统计');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
});

test('collapsed directory bytes remain visible without changing direct file totals',()=>{
  const rows=[{id:'r',parentId:null,path:'C:\\',bytes:100,ownBytes:10,omittedBytes:30},{id:'a',parentId:'r',path:'C:\\a',bytes:60,ownBytes:60}];
  const children=directoryChildren(rows,'r');
  assert.equal(children.reduce((sum,item)=>sum+item.bytes,0),100);
  assert.equal(children.find(item=>item.id==='r:omitted').bytes,30);
  assert.equal(children.find(item=>item.id==='r:own').bytes,10);
});
