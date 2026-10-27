import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createScanner } from './scanner.mjs';
import { getInventory as readInventory } from './inventory.mjs';
import { createActionManager } from './actions.mjs';
import { localPath, samePath, manifest, inside } from './safety.mjs';

const project=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const defaultLocal=process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local');
const defaults={npm:path.join(defaultLocal,'npm-cache'),pip:path.join(defaultLocal,'pip','Cache'),uv:path.join(defaultLocal,'uv','cache')};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const json=(response,status,data)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(data));};

export async function createService({stateDir=path.join(project,'.liubai'),getInventory=readInventory,allowedRoots=defaults,config,distDir=path.join(project,'dist')}={}) {
  const token=randomBytes(32).toString('hex');
  const manager=await createActionManager({stateDir,getInventory,allowedRoots,config});
  let inventory=null,inventoryAt=0,inventoryPending=null,inventoryError=null;
  async function currentInventory(force=false) {
    if(!force&&inventory&&Date.now()-inventoryAt<10000)return inventory;
    if(!inventoryPending)inventoryPending=getInventory().then(result=>{inventory=result;inventoryAt=Date.now();inventoryError=null;return result;}).catch(error=>{inventoryError=error.message;return inventory||{drives:[],caches:[]};}).finally(()=>{inventoryPending=null;});
    return inventoryPending;
  }
  const scanFile=path.join(stateDir,'last-scan.json');let scanState=null,scanWrite=Promise.resolve();
  try {scanState=JSON.parse(await fs.readFile(scanFile,'utf8'));if(scanState.status==='running')scanState={...scanState,status:'interrupted',complete:false};}catch(error){if(error.code!=='ENOENT')await manager.addHistory('旧扫描快照无法读取',error.message,'warning');}
  const scanner=createScanner({onUpdate:update=>{
    scanState=update;
    if(['completed','cancelled','failed'].includes(update.status)) {
      scanWrite=scanWrite.then(async()=>{
        const temp=scanFile+'.tmp';await fs.writeFile(temp,JSON.stringify(update));await fs.rename(temp,scanFile);
        await manager.addHistory(update.status==='completed'?'只读扫描结束':update.status==='cancelled'?'扫描已取消':'扫描失败',`${update.root}；已统计 ${update.filesCount} 个文件、${update.totalBytes} 字节；跳过 ${update.skipped} 项，错误 ${update.errors} 项。`,update.status==='completed'&&update.complete?'success':'warning');
      }).catch(error=>{console.error('扫描记录写入失败:',error.message);});
    }
  }});
  if(!scanState)scanState=scanner.getState();
  const state=async()=>{
    const inv=await currentInventory();
    const directoryMap=new Map((scanState.directories||[]).map(d=>[path.resolve(d.path).toLowerCase(),d]));
    const caches=inv.caches.map(c=>{const node=directoryMap.get(path.resolve(c.path).toLowerCase());return {...c,bytes:node?.bytes??null,sizeIsPartial:node?scanState.complete!==true:false};});
    return {version:'1.0.0',platform:process.platform,csrfToken:token,...inv,caches,inventoryError,scan:scanState,...manager.getState()};
  };
  async function body(request) {
    if(!/^application\/json(?:;|$)/i.test(request.headers['content-type']||''))throw new Error('请求必须使用 application/json');
    let text='';for await(const chunk of request){text+=chunk;if(Buffer.byteLength(text)>16384)throw new Error('请求内容过大');}
    const value=JSON.parse(text||'{}');if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('请求应为 JSON 对象');return value;
  }
  const server=http.createServer(async(request,response)=>{
    response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port=server.address()?.port;const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
    const origin=request.headers.origin;
    if(!['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress)||!hosts.includes(request.headers.host)||(origin&&!hosts.map(h=>'http://'+h).includes(origin))||request.headers['sec-fetch-site']==='cross-site')return json(response,403,{error:'仅允许来自本机界面的访问'});
    try {
      const url=new URL(request.url,'http://'+request.headers.host);
      if(url.pathname.startsWith('/api/')) {
        if(request.method==='GET') {
          if(url.pathname==='/api/health')return json(response,200,{ok:true,name:'liubai',version:'1.0.0'});
          if(url.pathname==='/api/state')return json(response,200,await state());
          return json(response,404,{error:'接口不存在'});
        }
        if(request.method!=='POST')return json(response,405,{error:'不支持的请求方法'});
        const supplied=request.headers['x-liubai-token'];
        if(typeof supplied!=='string'||supplied.length!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))return json(response,403,{error:'会话凭据无效，请刷新本机界面'});
        const input=await body(request);
        if(url.pathname==='/api/scan') {
          if(manager.getState().operations.some(o=>o.status==='running'))throw new Error('文件操作进行中，请稍后扫描');
          const root=localPath(input.root);await manifest(root,true);
          if(manager.getState().operations.some(o=>o.status==='running'))throw new Error('文件操作进行中，请稍后扫描');
          return json(response,200,await scanner.start(root));
        }
        if(url.pathname==='/api/scan/cancel')return json(response,200,scanner.cancel());
        if(url.pathname==='/api/plans')return json(response,200,await manager.plan(input));
        if(url.pathname==='/api/execute') {
          if(scanState.status==='running')throw new Error('请先结束扫描，再执行文件操作');
          const result=await manager.execute(input);inventoryAt=0;return json(response,200,result);
        }
        if(url.pathname==='/api/reveal') {
          const target=localPath(input.path);const inv=await currentInventory();
          const observed=[...inv.caches,...scanState.directories,...scanState.largeFiles,...manager.getState().operations.flatMap(o=>[{path:o.source},{path:o.target}])];
          if(!observed.some(item=>item.path&&samePath(item.path,target)))throw new Error('只能打开已扫描或已记录的路径');
          await manifest(target,true);
          if(process.platform!=='win32')throw new Error('此功能仅在 Windows 上提供');
          const child=spawn('explorer.exe',[`/select,${target}`],{windowsHide:true,detached:true,stdio:'ignore'});
          await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return json(response,200,{ok:true});
        }
        return json(response,404,{error:'接口不存在'});
      }
      if(request.method!=='GET'&&request.method!=='HEAD')return json(response,405,{error:'不支持的请求方法'});
      const decoded=decodeURIComponent(url.pathname);
      const filename=path.resolve(distDir,'.'+(decoded==='/'?'/index.html':decoded));
      if(!inside(filename,distDir))return json(response,403,{error:'路径越界'});
      let bytes;
      try {bytes=await fs.readFile(filename);}catch {return json(response,404,{error:'界面文件不存在，请先运行 npm run build'});}
      response.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream'});response.end(request.method==='HEAD'?undefined:bytes);
    }catch(error){if(!response.headersSent)json(response,400,{error:error.message});else response.end();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,state,manager,listen:(port=4317)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);}),close:async()=>{scanner.cancel();await manager.waitForIdle();await scanWrite;await new Promise(resolve=>server.close(resolve));server.closeAllConnections();}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.LIUBAI_PORT||4317);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('端口必须在 1024–65535 之间');
  const service=await createService();
  try {await service.listen(port);console.log(`留白 V1 已启动：http://127.0.0.1:${port}/（仅本机）`);}catch(error){console.error(`启动失败：${error.message}。如端口已被原型占用，请先关闭旧预览服务。`);process.exitCode=1;}
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await service.close();process.exit(0);});
}
