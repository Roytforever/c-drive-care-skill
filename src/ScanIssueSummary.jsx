import React from 'react';
import { issueDisplaySummary } from './report-model.js';

function IssueGroup({ scan, kind, title }) {
  const item=issueDisplaySummary(scan,kind);
  return <section className="static-issue-group" aria-label={title}>
    <h4>{title}<strong>{item.total.toLocaleString()} 项</strong></h4>
    <p>保留最早的 {item.retained.toLocaleString()} 条具体路径；另有 {item.omitted.toLocaleString()} 条路径明细未保留。计数表示遇到的问题入口，不代表其下所有文件的数量。</p>
    {item.summaryStatus==='legacy'&&<p className="static-warning-text">历史快照没有完整的原因和目录统计。已保留明细按遍历顺序截取，不能据此推算全部原因或影响范围。</p>}
    {item.summaryStatus==='invalid'&&<p className="static-warning-text">快照中的原因或目录汇总无效，不能作为完整统计；请重新扫描生成报告。</p>}
    {item.completeSummary&&<>
      <h5>原因统计 · 全部 {item.total.toLocaleString()} 项</h5>
      {item.reasonCounts.length?<ul className="static-issue-reasons">{item.reasonCounts.map((row,index)=><li key={row.code+':'+index}><span>{row.label}</span><strong>{row.count.toLocaleString()} 项</strong></li>)}</ul>:<p>没有记录此类问题。</p>}
      <details className="static-issue-directories"><summary>查看受影响目录 · {item.directories.length.toLocaleString()} 处</summary>
        <p>按问题入口归组；数字表示事件数，不能作为遗漏文件数或遗漏体积。</p>
        {item.directories.length?<ul>{item.directories.map((row,index)=><li key={row.path+':'+index}><code>{row.path}</code><span>{row.count.toLocaleString()} 项</span></li>)}</ul>:<p>没有记录目录。</p>}
        {item.otherDirectoryEvents>0&&<p className="static-warning-text">另有 {item.otherDirectoryEvents.toLocaleString()} 次事件所属目录未收录到目录汇总。</p>}
      </details>
    </>}
    {item.details.length>0&&<details><summary>查看保留的 {item.retained.toLocaleString()} 条具体路径</summary><div className="static-issues">{item.details.map((row,index)=><article key={row.path+':'+index}><code>{row.path}</code><small>{row.reason}</small></article>)}</div></details>}
  </section>;
}

export default function ScanIssueSummary({ scan }) {
  return <div className="static-issue-summary">
    <p>失败或跳过的范围可能影响索引完整性；不能仅凭事件数量推算遗漏体积。重解析项可能是链接、挂载点或其他特殊项，不一定都已通过其他路径统计。</p>
    <IssueGroup scan={scan} kind="errors" title="读取失败"/>
    <IssueGroup scan={scan} kind="skipped" title="主动跳过"/>
  </div>;
}
