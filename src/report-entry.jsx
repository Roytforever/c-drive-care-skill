import React from 'react';
import { createRoot } from 'react-dom/client';
import StaticReport from './StaticReport.jsx';
import { validateReportState } from './report-model.js';
import './styles.css';

const root=createRoot(document.getElementById('root'));
root.render(<main style={{padding:32,fontFamily:'system-ui',color:'#527363'}}><h1>正在打开磁盘报告</h1><p>正在读取内嵌快照，文件较大时请稍候。无需网络或本地服务。</p></main>);
async function openReport() {
  try {
    const element=document.getElementById('liubai-report-data');
    if(!element)throw new Error('报告缺少内嵌快照。');
    let text=element.textContent;
    if(element.dataset.encoding==='gzip-base64') {
      if(typeof DecompressionStream==='undefined')throw new Error('当前浏览器不支持压缩报告。请使用新版 Edge/Chrome/Firefox，或用 --no-compress 重新生成。');
      const bytes=Uint8Array.from(atob(text.trim()),character=>character.charCodeAt(0));
      const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      text=await new Response(stream).text();
    }
    const data=JSON.parse(text);validateReportState(data);
    root.render(<React.StrictMode><StaticReport initialData={data}/></React.StrictMode>);
  }catch(error) {
    root.render(<main style={{padding:32,fontFamily:'system-ui'}}><h1>报告数据无法读取</h1><p>{error.message||'请用原始快照重新生成 report.html。'}</p></main>);
  }
}
openReport();
