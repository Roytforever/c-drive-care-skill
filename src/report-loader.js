import ReportReader from './report-reader.worker.js?worker&inline';
import { readReportData } from './read-report-data.js';

export async function loadReportData(text, encoding = 'json', imported = false) {
  let worker;
  try {
    if (typeof Worker !== 'undefined') worker = new ReportReader();
  } catch {
    // Older browsers can still read an uncompressed report on the main thread.
  }
  if (!worker) return readReportData(text, encoding, imported);
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.data);
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('浏览器未能启动离线数据读取器，请更新浏览器后重新打开报告。'));
    };
    worker.postMessage({ text, encoding, imported });
  });
}
