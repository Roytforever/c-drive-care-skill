import { readReportData } from './read-report-data.js';

self.onmessage = async ({ data: { text, encoding, imported } }) => {
  try {
    const data = await readReportData(text, encoding, imported);
    self.postMessage({ data });
  } catch (error) {
    self.postMessage({ error: error.message || '报告数据无法读取。' });
  }
};
