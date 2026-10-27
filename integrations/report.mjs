import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));

/** One-shot, service-free report generation. Inputs remain argv data; no shell is involved. */
export async function generateStaticReport(input = {}) {
  const reportOnly = input.reportOnly ?? false;
  const overwrite = input.overwrite ?? false;
  if (typeof reportOnly !== 'boolean') throw new Error('reportOnly 必须为布尔值');
  if (typeof overwrite !== 'boolean') throw new Error('overwrite 必须为布尔值');
  if (reportOnly && !input.index) throw new Error('reportOnly 必须提供 index 索引路径');
  if (reportOnly && input.root) throw new Error('快照重建不能同时指定 root 扫描路径');
  if (input.index && !reportOnly) throw new Error('读取已有 index 时请设置 reportOnly:true，避免误启动扫描');
  const args = [fileURLToPath(new URL('../run.py', import.meta.url))];
  if (reportOnly) args.push('--report-only', '--index', path.resolve(input.index));
  else {
    const root = input.root || 'C:\\';
    if (!path.isAbsolute(root) || root.startsWith('\\\\') || root.startsWith('//') || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(root))) throw new Error('扫描仅支持本地绝对目录，不支持网络或设备路径');
    args.push(root);
  }
  args.push('--out-dir', input.outDir ? path.resolve(input.outDir) : path.join(project, 'report'));
  if (overwrite) args.push('--overwrite');
  let output;
  try {
    output = await run('python', args, { cwd: project, windowsHide: true, encoding: 'utf8',
      timeout: 33 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    if (error.code === 2 && error.stdout?.trim().startsWith('{')) output = error;
    else {
      let message = error.code === 'ENOENT' ? '未找到 Python，请安装 Python 3 并加入 PATH。' : error.stderr?.trim().split('\n').at(-1) || error.message;
      try { message = JSON.parse(message).error || message; } catch {}
      throw new Error(String(message).slice(0, 2000));
    }
  }
  let summary;
  try { summary = JSON.parse(output.stdout.trim()); }
  catch { throw new Error('报告生成器没有返回有效的 JSON 结果'); }
  if (!summary.report || !summary.index || !summary.status) throw new Error('报告生成器未提供可验证的产物路径');
  return { ...summary, fileUri: pathToFileURL(summary.report).href, static: true,
    requiresLocalService: false, note: summary.status === 'completed'
      ? '静态报告已生成，可直接打开 HTML；不依赖本地服务。页面仅供分析、复制路径和导出建议，不执行文件或配置变更。'
      : '已保留部分/失败扫描的静态报告，请按报告中的状态与错误分析；没有执行文件或配置变更。' };
}
