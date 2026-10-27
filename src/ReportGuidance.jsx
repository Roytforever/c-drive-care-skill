import React, { useRef, useState } from 'react';
import { ArrowRight, ArrowLeftRight, ClipboardList, FolderSearch, History, Settings, ShieldCheck, Upload } from 'lucide-react';
import { compareSnapshots } from './report-model.js';
import { loadReportData } from './report-loader.js';
import { dateLabel, formatBytes } from './ui-model.js';

const icons = { check: FolderSearch, official: Settings, relocate: ArrowLeftRight, keep: ShieldCheck };
const sourceLabels = { default: '默认路径线索', environment: '环境变量配置', configured: '配置文件线索', config: '配置文件线索' };

export function AllocationSummary({ scan }) {
  const value = scan.allocation;
  if (!value?.requested) return <p>本次没有测量磁盘分配量。需要进一步核验时，可在新扫描命令中显式添加 <code>--measure-allocated</code>；该模式会增加元数据查询。</p>;
  const complete = value.status === 'complete';
  return <section className="report-file-coverage" aria-label="分配量测量结果">
    <h3>可选分配量测量 · {complete ? '已完成' : '仅部分可测'}</h3>
    <dl><dt>去重后的磁盘分配量</dt><dd>{complete ? formatBytes(value.allocatedBytes) : '未知，不能将未测部分当作 0'}</dd>
      <dt>已测部分分配量</dt><dd>{formatBytes(value.knownAllocatedBytes)}</dd>
      <dt>已识别的重复路径</dt><dd>{(value.duplicatePaths || 0).toLocaleString()} 项</dd>
      <dt>测量失败 / 达到上限</dt><dd>{value.errors || 0} / {value.omittedFiles || 0} 项</dd></dl>
    <p>只对当前扫描范围内的文件身份去重；目录归属采用首次遇到的路径。硬链接可能仍被其他路径引用，分配量不等于删除某个路径后的释放量。</p>
  </section>;
}

export function CacheEvidence({ item }) {
  const coverage = typeof item.coverage === 'string' ? item.coverage : item.coverage?.status;
  return <small className="report-evidence">
    <span>{sourceLabels[item.source] || (item.source ? '已记录路径来源' : '路径规则线索')}</span>
    {item.exists !== true && <span>{item.exists === false ? '该位置未发现目录' : '存在状态无法确认 · 仅供调查'}</span>}
    <span>{coverage === 'complete' ? '该目录遍历未记录遗漏' : coverage === 'partial' || item.sizeIsPartial ? '该目录统计可能不完整' : '该目录完整度未记录'}</span>
  </small>;
}

export function ActionGuide({ recommendations, onChoose }) {
  return <section className="report-action-section" aria-label="从这里开始">
    <div className="report-section-heading"><div><h2>从这里开始</h2><p>先找到占用原因，再选择适合它的处理方式。</p></div><span>查看与规划 · 操作另行确认</span></div>
    <div className="report-action-grid">{recommendations.map(item => {
      const Icon = icons[item.id] || ClipboardList;
      return <button key={item.id} className={`report-action-card report-action-${item.id}`} onClick={() => onChoose(item)}>
        <Icon size={22}/><strong>{item.title}</strong><p>{item.description}</p>
        <span>{item.items?.length ? `${item.items.length} 处线索` : '查看处理方法'}<ArrowRight size={15}/></span>
      </button>;
    })}</div>
  </section>;
}

export function FileCoverage({ model, directory, onRescan }) {
  const value = model.fileCoverage(directory.id);
  return <div className="report-file-coverage">
    <p><strong>已收录 {value.retained.toLocaleString()} 个直属文件</strong>{value.total != null ? ` / 遍历记录 ${value.total.toLocaleString()} 个` : ' · 历史快照未记录该目录的文件总数'}。</p>
    <p>{value.legacy ? '这份历史快照只有全盘大文件排行，目录内的小文件可能未收录。' : value.limited ? '这里按目录保留主要文件；数量或全局容量达到上限时，其余文件仍计入目录逻辑总量。' : '已遍历并记录的直属普通文件均有明细。'}{value.coverage?.status === 'partial' ? ' 该目录还存在读取失败或主动跳过，实际内容可能更多。' : ''}</p>
    <button className="text-button" onClick={onRescan}>查看如何单独扫描这个目录<ArrowRight size={13}/></button>
  </div>;
}

export function SnapshotComparison({ current, onInspect }) {
  const input = useRef(null);
  const [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const compare = async event => {
    const file = event.target.files?.[0]; if (!file) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const previous = await loadReportData(await file.text(), 'json', true);
      setResult(compareSnapshots(previous, current));
    } catch (err) { setError(err.message || '无法读取这份快照。'); }
    finally { setBusy(false); event.target.value = ''; }
  };
  return <section className="panel report-comparison" aria-label="与上次相比">
    <div className="report-section-heading"><div><h2><History size={18}/> 最近为什么变满了</h2><p>选择同一范围的旧 JSON 快照，对比目录逻辑大小。文件在本页本地读取。</p></div>
      <button className="btn btn-secondary" disabled={busy} onClick={() => input.current?.click()}><Upload size={14}/>{busy ? '正在读取旧快照…' : '选择旧快照对比'}</button>
      <input type="file" accept=".json,application/json" ref={input} className="sr-only" aria-label="选择用于对比的旧 JSON 快照" onChange={compare}/>
    </div>
    {error && <p role="alert" className="static-warning-text">{error}</p>}
    {result && !result.compatible && <p role="status" className="static-warning-text">{result.reason}</p>}
    {result?.compatible && <>
      <p className="report-comparison-note">{dateLabel(result.previousAt)} → {dateLabel(result.currentAt)}。{result.partial ? '至少一份快照覆盖不完整，变化可能来自扫描差异，请逐项核验。' : '两次快照的扫描范围一致。'} 仅比较两份都收录的目录，缺失不能当作 0；父子目录变化量不能相加，也不等于可释放空间。</p>
      {result.changes.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>目录</th><th>之前</th><th>本次</th><th>变化</th></tr></thead><tbody>{result.changes.map(item => <tr key={item.path}><td><button className="static-path-button" onClick={() => onInspect(item)}><span><strong>{item.name}</strong><small className="mono">{item.path}</small></span></button></td><td>{formatBytes(item.beforeBytes)}</td><td>{formatBytes(item.afterBytes)}</td><td className={item.deltaBytes > 0 ? 'report-growth' : 'report-shrink'}>{item.deltaBytes > 0 ? '+' : '−'}{formatBytes(Math.abs(item.deltaBytes))}</td></tr>)}</tbody></table></div> : <p>已收录目录没有可比较的大小变化。</p>}
      <button className="text-button" onClick={() => setResult(null)}>收起对比结果</button>
    </>}
  </section>;
}
