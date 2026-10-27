const norm=value=>String(value||'').replaceAll('/','\\').replace(/\\+$/,'').toLowerCase();
export const within=(child,parent)=>norm(child)===norm(parent)||norm(child).startsWith(norm(parent)+'\\');
export const directParent=value=>norm(value).slice(0,norm(value).lastIndexOf('\\'));
const secretKeys=new Set(['csrftoken','confirmationtext','snapshot','relatedsnapshot','previousconfig','token','accesstoken','authorization','apikey','password','secret','credentials','plans']);
export function safeReportExport(value) {
  if(Array.isArray(value))return value.map(safeReportExport);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!secretKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g,''))).map(([key,item])=>[key,safeReportExport(item)]));
  return value;
}
export function resolveTreeAction(item) {
  if(item.type==='more')return {kind:'group',items:item.items};
  if(item.type==='own')return {kind:'files',directoryId:item.parentId};
  if(item.type==='omitted')return {kind:'coverage',directoryId:item.parentId};
  return {kind:'directory',directoryId:item.id};
}

const catalog=[
  {tool:'npm',name:'npm 下载与 npx 缓存',pattern:/\\appdata\\local\\npm-cache$/,risk:'rebuildable',envKey:'NPM_CONFIG_CACHE',strategy:'通过 NPM_CONFIG_CACHE 或 npm 的 cache 配置切换目录。先关闭安装/npx 任务，复制并校验，再在新终端验证。',cost:'可能需要重新下载依赖；npx 的临时运行环境可能仍在使用。'},
  {tool:'pip',name:'pip 下载缓存',pattern:/\\appdata\\local\\pip\\cache$/,risk:'rebuildable',envKey:'PIP_CACHE_DIR',strategy:'设置 PIP_CACHE_DIR；在新终端用 pip cache dir 核验。保留原副本直到项目安装验证通过。',cost:'离线环境可能无法重建依赖。'},
  {tool:'uv',name:'uv 缓存',pattern:/\\appdata\\local\\uv\\cache$/,risk:'review',envKey:'UV_CACHE_DIR',strategy:'设置 UV_CACHE_DIR；先退出使用缓存的进程，注意跨卷硬链接会退化成复制。',cost:'可能混有脚本环境和硬链接，需用工具确认；不能只按名称清理。'},
  {tool:'yarn',name:'Yarn Berry 包缓存',pattern:/\\appdata\\local\\yarn\\berry\\cache$/,risk:'rebuildable',envKey:'YARN_GLOBAL_FOLDER',strategy:'先核验 Yarn 版本与 enableGlobalCache。全局缓存使用 globalFolder；项目缓存使用 cacheFolder。不要直接移动项目的零安装缓存。',cost:'可能依赖离线包和项目锁文件，迁移后要重新验证安装。'},
  {tool:'pnpm-store',name:'pnpm store',pattern:/\\appdata\\local\\pnpm\\store(?:\\v\d+)?$/,risk:'review',strategy:'先用 pnpm store path 确认实际 store，再按项目所在卷规划 store-dir。保留旧 store 并验证项目。',cost:'硬链接关系与所在卷有关，不适合通用搬移。'},
  {tool:'pnpm-cache',name:'pnpm 下载缓存',pattern:/\\appdata\\local\\pnpm-cache(?:\\v\d+)?$/,risk:'review',strategy:'这是下载缓存位置线索，不等于 pnpm store。先核验 cache-dir 与所属版本，不能套用 store-dir 命令。',cost:'配置与目录用途需要由工具核验。'},
  {tool:'playwright',name:'Playwright 浏览器',pattern:/\\appdata\\local\\ms-playwright$/,risk:'review',envKey:'PLAYWRIGHT_BROWSERS_PATH',strategy:'在安装和运行时使用相同的 PLAYWRIGHT_BROWSERS_PATH，通过工具安装所需浏览器后验证项目。',cost:'每个项目可能要求不同的浏览器版本；不要把浏览器 profile 当下载缓存。'},
  {tool:'puppeteer',name:'Puppeteer 浏览器',pattern:/\\\.cache\\puppeteer$/,risk:'review',envKey:'PUPPETEER_CACHE_DIR',strategy:'通过 PUPPETEER_CACHE_DIR 或 cacheDirectory 指定位置，重新安装所需浏览器并验证任务。',cost:'需要网络与对应浏览器版本。'},
  {tool:'huggingface',name:'Hugging Face 模型缓存',pattern:/\\\.cache\\huggingface\\hub$/,risk:'review',envKey:'HF_HUB_CACHE',strategy:'优先只规划 HF_HUB_CACHE，保留模型版本、refs 和 snapshots 的完整结构。不要把 token/账号配置作为缓存搬移。',cost:'模型重下载受网络、权限和来源可用性影响。'},
  {tool:'hyperframes',name:'Hyperframes 浏览器与字体',pattern:/\\\.cache\\hyperframes$/,risk:'review',strategy:'从工具的配置与运行方式核验目录后再规划。没有通用迁移开关时保留原位，通过工具自身管理。',cost:'依赖特定浏览器和字体；需验证视频渲染。'},
];
function uniqueRoots(items) {const sorted=[...items].sort((a,b)=>norm(a.path).length-norm(b.path).length);return sorted.filter((item,index)=>!sorted.slice(0,index).some(parent=>within(item.path,parent.path)));}

export function summarizeCacheCandidates(candidates) {
  const eligible=candidates.filter(item=>item.eligible!==false);
  const items=eligible.filter(item=>Number.isFinite(item.bytes));
  const totalBytes=items.reduce((sum,item)=>sum+item.bytes,0);
  const rebuildableBytes=items.filter(item=>item.risk==='rebuildable').reduce((sum,item)=>sum+item.bytes,0);
  return {items,totalBytes,count:items.length,unknownCount:eligible.length-items.length,rebuildableBytes,reviewBytes:totalBytes-rebuildableBytes};
}

// A historical snapshot retains only an early sample of individual issues.
// Treat an absent, malformed or inconsistent aggregate as unknown, never as a
// complete count inferred from the retained sample.
export function issueDisplaySummary(scan, kind) {
  const total=Number.isSafeInteger(scan?.[kind])&&scan[kind]>=0?scan[kind]:0;
  const detailsKey=kind==='errors'?'errorDetails':'skipDetails';
  const details=Array.isArray(scan?.[detailsKey])?scan[detailsKey]:[];
  const payload=scan?.issueSummary, group=payload?.[kind];
  const count=value=>Number.isSafeInteger(value)&&value>=0;
  const valid=payload?.version===1 && group && Array.isArray(group.reasonCounts) &&
    Array.isArray(group.directories) && group.directories.length<=2000 &&
    group.reasonCounts.every(row=>row&&typeof row.code==='string'&&typeof row.label==='string'&&count(row.count)) &&
    group.directories.every(row=>row&&typeof row.path==='string'&&row.path.length>0&&count(row.count)) &&
    count(group.otherDirectoryEvents) &&
    group.reasonCounts.reduce((sum,row)=>sum+row.count,0)===total &&
    group.directories.reduce((sum,row)=>sum+row.count,0)+group.otherDirectoryEvents===total;
  return {total,details,retained:details.length,omitted:Math.max(0,total-details.length),
    completeSummary:!!valid,summaryStatus:valid?'complete':payload==null?'legacy':'invalid',
    reasonCounts:valid?group.reasonCounts:null,directories:valid?group.directories:null,
    otherDirectoryEvents:valid?group.otherDirectoryEvents:null};
}

export function validateReportState(value) {
  const scan=value?.scan;if(!scan||!Array.isArray(scan.directories)||!Array.isArray(scan.largeFiles))throw new Error('缺少目录或文件索引');
  if(typeof scan.root!=='string'||!scan.root||!['completed','cancelled','failed','interrupted'].includes(scan.status))throw new Error('扫描范围或结束状态无效');
  const numeric=number=>typeof number==='number'&&Number.isFinite(number)&&number>=0;
  const optionalName=item=>{if(item.name!==undefined&&typeof item.name!=='string')throw new Error('记录名称字段无效');};
  for(const key of ['totalBytes','filesCount','dirsCount','errors','skipped'])if(scan[key]!==undefined&&!numeric(scan[key]))throw new Error('扫描统计字段无效');
  for(const key of ['drives','caches','history','operations'])if(value[key]!==undefined){if(!Array.isArray(value[key])||value[key].some(item=>!item||typeof item!=='object'||Array.isArray(item)))throw new Error('报告字段或记录无效：'+key);}
  for(const drive of value.drives||[]){if(typeof drive.path!=='string'||typeof drive.id!=='string'||(drive.label!==undefined&&typeof drive.label!=='string'))throw new Error('磁盘记录字段无效');for(const key of ['totalBytes','freeBytes'])if(drive[key]!=null&&!numeric(drive[key]))throw new Error('磁盘容量字段无效');}
  for(const cache of value.caches||[]){if(typeof cache.path!=='string'||typeof cache.id!=='string'||(cache.bytes!=null&&!numeric(cache.bytes)))throw new Error('缓存记录字段无效');optionalName(cache);}
  for(const list of [scan.warnings,value.report?.inventoryWarnings])if(list!==undefined&&(!Array.isArray(list)||list.some(item=>typeof item!=='string')))throw new Error('报告警告字段无效');
  for(const list of [scan.errorDetails,scan.skipDetails])if(list!==undefined&&(!Array.isArray(list)||list.some(item=>!item||typeof item.path!=='string'||typeof item.reason!=='string')))throw new Error('错误明细字段无效');
  const map=new Map();
  for(const row of scan.directories){if(!row||typeof row.id!=='string'||map.has(row.id)||typeof row.path!=='string'||!numeric(row.bytes))throw new Error('目录索引格式无效或标识重复');optionalName(row);for(const key of ['ownBytes','omittedBytes'])if(row[key]!==undefined&&!numeric(row[key]))throw new Error('目录体积字段无效');map.set(row.id,row);}
  if(map.size&&scan.directories.filter(row=>row.parentId==null).length!==1)throw new Error('目录树缺少唯一根目录');
  const checked=new Set();
  for(const node of scan.directories){let row=node;const seen=new Set();while(row&&!checked.has(row.id)){if(seen.has(row.id))throw new Error('目录树存在循环');seen.add(row.id);if(row.parentId==null)break;if(!map.has(String(row.parentId)))throw new Error('目录索引缺少父节点');row=map.get(String(row.parentId));}for(const id of seen)checked.add(id);}
  for(const file of scan.largeFiles){if(!file||typeof file.path!=='string'||!numeric(file.bytes))throw new Error('文件索引格式无效');optionalName(file);}
  return true;
}

export function createReportModel(state) {
  const scan=state.scan||{},rows=scan.directories||[],files=(scan.largeFiles||[]).map(file=>({...file,name:file.name||String(file.path).split(/[\\/]/).at(-1)}));
  const byId=new Map(rows.map(row=>[String(row.id),row]));
  const byPath=new Map(rows.map(row=>[norm(row.path),row]));
  const childIndex=new Map();
  for(const row of rows) {const parent=String(row.parentId);if(!childIndex.has(parent))childIndex.set(parent,[]);if(row.parentId!=null)childIndex.get(parent).push(row);}
  for(const children of childIndex.values())children.sort((a,b)=>b.bytes-a.bytes);
  const root=rows.find(row=>row.parentId==null)||rows[0];
  const children=id=>{
    const row=byId.get(String(id));if(!row)return[];
    const result=[...(childIndex.get(String(id))||[])];
    if(row.ownBytes>0)result.push({id:`${id}:own`,parentId:row.id,name:'直属文件',path:row.path,bytes:row.ownBytes,type:'own'});
    if(row.omittedBytes>0)result.push({id:`${id}:omitted`,parentId:row.id,name:'快照中未保留的小目录',path:row.path,bytes:row.omittedBytes,type:'omitted'});
    return result.sort((a,b)=>b.bytes-a.bytes);
  };
  const trail=id=>{const result=[],seen=new Set();let row=byId.get(String(id));while(row&&!seen.has(String(row.id))){result.unshift(row);seen.add(String(row.id));row=byId.get(String(row.parentId));}return result;};
  const filesIn=(directory,direct=false)=>files.filter(file=>direct?directParent(file.path)===norm(directory):within(file.path,directory));
  const known=rows.flatMap(row=>{const rule=catalog.find(item=>item.pattern.test(norm(row.path)));return rule?[{...rule,...row,name:rule.name,directoryName:row.name,id:'candidate:'+norm(row.path),directoryId:row.id,exists:true,eligible:true}]:[];});
  for(const item of state.caches||[]) {
    if(known.some(entry=>norm(entry.path)===norm(item.path))||item.exists===false)continue;
    const rule=catalog.find(entry=>entry.tool===item.id);
    if(rule){const custom=item.defaultPath?norm(item.path)!==norm(item.defaultPath):!rule.pattern.test(norm(item.path));known.push({...rule,...item,name:rule.name,id:'candidate:'+norm(item.path),directoryId:byPath.get(norm(item.path))?.id,bytes:byPath.get(norm(item.path))?.bytes??item.bytes??null,risk:custom?'protected':rule.risk,eligible:!custom,strategy:custom?'这是自定义配置目录，可能混有文档或用户数据。只展示调查线索，不生成缓存搬移建议。':rule.strategy,cost:custom?'用途与可重建性未核验，保持保护。':rule.cost});}
  }
  const candidates=uniqueRoots(known).sort((a,b)=>(b.bytes||0)-(a.bytes||0));
  const cacheRows=candidates.filter(item=>Number.isFinite(item.bytes)&&item.eligible!==false);
  const tools=uniqueRoots(rows.filter(row=>/^[a-z]:\\users\\[^\\]+\\(?:\.codex|\.workbuddy|\.marscode|\.qoder|\.codebuddy|\.vscode|\.zcode)$/.test(norm(row.path))||/^[a-z]:\\users\\[^\\]+\\\.cache\\codex-runtimes$/.test(norm(row.path))));
  const appData=uniqueRoots(rows.filter(row=>/\\appdata$/.test(norm(row.path))));
  const documents=uniqueRoots(rows.filter(row=>/\\users\\[^\\]+\\(?:documents|downloads|desktop)$/.test(norm(row.path))));
  const baselines=uniqueRoots(rows.filter(row=>/^[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata)$/.test(norm(row.path))));
  // Assign only each node's direct bytes and omitted bytes. The nearest claim wins,
  // so a nested cache/tool location cannot be counted again in an ancestor group.
  const claims=new Map();
  for(const [id,items] of [['baseline',baselines],['documents',documents],['application-data',appData],['tools',tools],['caches',cacheRows]])for(const item of items){const row=byPath.get(norm(item.path));if(row)claims.set(String(row.id),id);}
  const categoryCache=new Map();
  const category=id=>{let row=byId.get(String(id)),kind='other';const chain=[],seen=new Set();while(row&&!seen.has(String(row.id))){const key=String(row.id);if(claims.has(key)){kind=claims.get(key);break;}if(categoryCache.has(key)){kind=categoryCache.get(key);break;}seen.add(key);chain.push(key);row=byId.get(String(row.parentId));}for(const key of chain)categoryCache.set(key,kind);return kind;};
  const totals=new Map();
  for(const row of rows){const id=category(row.id);totals.set(id,(totals.get(id)||0)+(Number(row.ownBytes)||0)+(Number(row.omittedBytes)||0));}
  const sum=id=>totals.get(id)||0;
  const findings=[];
  const add=(id,title,items,bytes,description,kind='finding')=>{if(bytes>0)findings.push({id,title,items,bytes,description,kind});};
  add('caches','开发依赖与浏览器缓存',cacheRows,sum('caches'),'先核验工具配置、重建条件与当前使用状态；体积不是可释放承诺。');
  add('tools','AI 工具、运行时与工作记录',tools,sum('tools'),'包含运行程序、会话、插件、工作区与历史，需要按用途核验，不能整目录视作缓存。');
  add('application-data','应用数据与离线内容',appData,sum('application-data'),'这里已扣除单独归类的缓存或工具目录，剩余可能含账号、数据库、聊天附件、配置和离线内容。');
  add('documents','用户文档、下载与桌面',documents,sum('documents'),'可能含唯一副本、安装包或归档；逐项确认来源和保留需求。');
  const accounted=findings.reduce((n,item)=>n+item.bytes,0)+sum('baseline');
  add('other','其他已统计内容',[],Math.max(0,(scan.totalBytes||root?.bytes||0)-accounted),'包含尚未归类的目录及直属文件；通过空间浏览进一步定位。');
  findings.sort((a,b)=>b.bytes-a.bytes);
  add('baseline','系统与已安装应用基线',baselines,sum('baseline'),'系统与应用安装成本作为基线展示。不要直接删除 Windows、Installer、WinSxS 或程序目录。','baseline');
  return {scan,rows,files,byId,byPath,childIndex,root,children,trail,filesIn,candidates,findings,cacheSummary:summarizeCacheCandidates(candidates)};
}

export function migrationProposal(item,drive) {
  if(item.eligible===false)throw new Error('自定义目录用途未核验，可能混合用户数据');
  if(!drive||drive.isSystem)throw new Error('请选择非系统盘');
  if(within(item.path,drive.path))throw new Error('请选择与源路径不同的磁盘');
  if(Number.isFinite(drive.freeBytes)&&Number.isFinite(item.bytes)&&drive.freeBytes<item.bytes+536870912)throw new Error('快照中的目标盘可用空间不足，请重新核验');
  const base=String(drive.path).replace(/[\\/]+$/,'')+'\\DevCaches\\'+item.tool;
  const target=item.tool==='yarn'?base+'\\cache':base;
  return {format:'liubai-manual-plan-v2',execution:'manual-review',generatedAt:new Date().toISOString(),tool:item.tool,name:item.name,source:item.path,target,configurationValue:item.tool==='yarn'?base:target,logicalBytes:item.bytes??null,environmentVariable:item.envKey||null,strategy:item.strategy,steps:['核验工具实际生效路径与目标盘空间','关闭使用缓存的程序，备份配置','复制并逐文件校验，保留原副本','通过工具官方配置切换路径','重启工具并验证项目；旧副本另行确认处理'],warnings:[item.cost,'本报告不会执行迁移、删除、隔离或环境变量修改。','这是离线建议，不是已核验且可直接执行的命令。'],immediateReleasedBytes:0};
}
