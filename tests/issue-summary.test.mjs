import test from 'node:test';
import assert from 'node:assert/strict';
import { issueDisplaySummary } from '../src/report-model.js';

test('new snapshots expose complete cause counts and explicit omitted detail and directory counts', () => {
  const scan = {
    errors: 5, errorDetails: [{path:'C:\\a',reason:'denied'}],
    issueSummary: {version:1, errors: {
      reasonCounts:[{code:'access_denied',label:'拒绝访问',count:3},{code:'path_missing',label:'路径不可访问',count:2}],
      directories:[{path:'C:\\',count:2},{path:'C:\\Users',count:2}], otherDirectoryEvents:1
    }}
  };
  const result = issueDisplaySummary(scan,'errors');
  assert.equal(result.total,5);
  assert.equal(result.retained,1);
  assert.equal(result.omitted,4);
  assert.equal(result.completeSummary,true);
  assert.equal(result.reasonCounts.reduce((sum,row)=>sum+row.count,0),5);
  assert.equal(result.directories.length,2);
  assert.equal(result.otherDirectoryEvents,1);
});

test('old snapshots never infer all causes or affected directories from retained early details', () => {
  const result = issueDisplaySummary({skipped:1105,skipDetails:Array.from({length:100},()=>({path:'C:\\old',reason:'reparse'}))},'skipped');
  assert.equal(result.total,1105);
  assert.equal(result.retained,100);
  assert.equal(result.omitted,1005);
  assert.equal(result.completeSummary,false);
  assert.equal(result.reasonCounts,null);
  assert.equal(result.directories,null);
});

test('malformed or inconsistent imported summaries do not render as complete evidence', () => {
  const base={errors:2,errorDetails:[]};
  for (const bad of [null,{}, {version:1,errors:{reasonCounts:{},directories:[],otherDirectoryEvents:0}},
    {version:1,errors:{reasonCounts:[{code:'x',label:'x',count:2}],directories:[{path:'C:\\',count:1}],otherDirectoryEvents:0}},
    {version:1,errors:{reasonCounts:[{code:'x',label:'x',count:Infinity}],directories:[],otherDirectoryEvents:0}},
    {version:1,errors:{reasonCounts:[{code:'x',label:'x',count:2}],directories:[{path:{},count:2}],otherDirectoryEvents:0}}]) {
    const result=issueDisplaySummary({...base,issueSummary:bad},'errors');
    assert.equal(result.completeSummary,false);
    assert.equal(result.reasonCounts,null);
  }
});
