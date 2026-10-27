import { safeReportExport, validateReportState } from './report-model.js';

/** Decode and validate off the UI thread when called by the bundled worker. */
export async function readReportData(input, encoding = 'json', imported = false) {
  let text = input;
  if (encoding === 'gzip-base64') {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持压缩报告。请更新浏览器，或用 --no-compress 重新生成。');
    }
    const bytes = Uint8Array.from(atob(text.trim()), character => character.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else if (encoding !== 'json') {
    throw new Error('报告数据编码不受支持。');
  }
  let data = JSON.parse(text);
  if (imported) {
    data = safeReportExport(data);
    data = data.scan
      ? { ...data, sourceMode: 'snapshot' }
      : { version: '2.0-static', sourceMode: 'snapshot', scan: data, drives: [], caches: [], history: [] };
  }
  validateReportState(data);
  return data;
}
