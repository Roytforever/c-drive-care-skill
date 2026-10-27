import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const dist=path.join(root,'report-build');
await build({root,configFile:false,base:'./',build:{outDir:dist,emptyOutDir:true,modulePreload:false,rollupOptions:{input:path.join(root,'report-entry.html'),output:{entryFileNames:'report.js',assetFileNames:'report.[ext]'}}}});
let html=await fs.readFile(path.join(dist,'report-entry.html'),'utf8');
const scripts=[...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)];
if(scripts.length!==1)throw new Error('Expected one compiled entry script');
const js=await fs.readFile(path.join(dist,scripts[0][1].replace(/^\//,'')),'utf8');
const licenses=await Promise.all(['react','react-dom','scheduler','lucide-react'].map(async name=>`${name}\n${await fs.readFile(path.join(root,'node_modules',name,'LICENSE'),'utf8')}`));
const licenseText=licenses.join('\n\n').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const styles=[...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
let css='';
for(const style of styles){css+=await fs.readFile(path.join(dist,style[1].replace(/^\//,'')),'utf8');html=html.replace(style[0],'');}
html=html.replace(scripts[0][0],'');
html=html.replace('</body>',()=>`<pre hidden id="liubai-licenses">${licenseText}</pre><script>${js.replace(/<\/script/gi,'<\\/script')}</script></body>`);
html=html.replace('</head>',()=>`<style>${css.replace(/<\/style/gi,'<\\/style')}</style></head>`);
html=html.replace(/<link\b[^>]*rel="icon"[^>]*>/g,'');
html=html.replace(/<meta name="description"[^>]*>/,'<meta name="description" content="留白 · 自包含静态磁盘报告。离线浏览、下钻、筛选与导出建议。">');
html=html.replace('<head>','<head>\n<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; worker-src blob:; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'">');
html=html.replace(/(<\/title>)[ \t]+\n[ \t]+\n/, '$1\n\n');
if(!html.includes('<!--LIUBAI_REPORT_DATA-->'))throw new Error('Snapshot marker missing');
await fs.mkdir(path.join(root,'report-assets'),{recursive:true});
await fs.writeFile(path.join(root,'report-assets','template.html'),html,'utf8');
console.log('Static single-file template built. No external JS, CSS or service required.');
