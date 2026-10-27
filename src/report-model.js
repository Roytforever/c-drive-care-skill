const norm=value=>String(value||'').replaceAll('/','\\').replace(/\\+$/,'').toLowerCase();
export const within=(child,parent)=>norm(child)===norm(parent)||norm(child).startsWith(norm(parent)+'\\');
export const directParent=value=>{const path=norm(value);return path.slice(0,path.lastIndexOf('\\'));};
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
  {tool:'gradle',name:'Gradle 缓存与构建状态',pattern:/\\\.gradle\\caches$/,risk:'protected',strategy:'先通过 Gradle 的缓存管理核验用途，按项目验证后再调整 GRADLE_USER_HOME；不提供通用删除或整目录搬移。',cost:'可能包含构建状态、离线依赖和正在使用的文件，保持保护。'},
  {tool:'maven',name:'Maven 本地仓库',pattern:/\\\.m2\\repository$/,risk:'protected',strategy:'核验 settings.xml 的 localRepository 与项目私有构件；本地安装但未发布的包可能无法重建。',cost:'可能含未发布私有构件，不能作为通用可重建缓存删除。'},
  {tool:'hyperframes',name:'Hyperframes 浏览器与字体',pattern:/\\\.cache\\hyperframes$/,risk:'review',strategy:'从工具的配置与运行方式核验目录后再规划。没有通用迁移开关时保留原位，通过工具自身管理。',cost:'依赖特定浏览器和字体；需验证视频渲染。'},
];
function uniqueRoots(items) {const sorted=[...items].sort((a,b)=>norm(a.path).length-norm(b.path).length);return sorted.filter((item,index)=>!sorted.slice(0,index).some(parent=>within(item.path,parent.path)));}

export function summarizeCacheCandidates(candidates) {
  const eligible=uniqueRoots(candidates.filter(item=>item.eligible!==false));
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
  const count=number=>Number.isSafeInteger(number)&&number>=0;
  const validateCoverage=coverage=>{if(!coverage||typeof coverage!=='object'||!['complete','partial','unscanned'].includes(coverage.status)||!count(coverage.errors)||!count(coverage.skipped))throw new Error('目录覆盖字段无效');};
  const optionalName=item=>{if(item.name!==undefined&&typeof item.name!=='string')throw new Error('记录名称字段无效');};
  for(const key of ['totalBytes','filesCount','dirsCount','errors','skipped'])if(scan[key]!==undefined&&!numeric(scan[key]))throw new Error('扫描统计字段无效');
  for(const key of ['drives','caches','history','operations'])if(value[key]!==undefined){if(!Array.isArray(value[key])||value[key].some(item=>!item||typeof item!=='object'||Array.isArray(item)))throw new Error('报告字段或记录无效：'+key);}
  for(const drive of value.drives||[]){if(typeof drive.path!=='string'||typeof drive.id!=='string'||(drive.label!==undefined&&typeof drive.label!=='string'))throw new Error('磁盘记录字段无效');for(const key of ['totalBytes','freeBytes'])if(drive[key]!=null&&!numeric(drive[key]))throw new Error('磁盘容量字段无效');}
  for(const cache of value.caches||[]){if(typeof cache.path!=='string'||typeof cache.id!=='string'||(cache.bytes!=null&&!numeric(cache.bytes)))throw new Error('缓存记录字段无效');optionalName(cache);if(cache.warnings!==undefined&&(!Array.isArray(cache.warnings)||cache.warnings.some(item=>typeof item!=='string')))throw new Error('缓存警告字段无效');for(const key of ['configPath','source'])if(cache[key]!=null&&typeof cache[key]!=='string')throw new Error('缓存来源字段无效');}
  for(const list of [scan.warnings,value.report?.inventoryWarnings])if(list!==undefined&&(!Array.isArray(list)||list.some(item=>typeof item!=='string')))throw new Error('报告警告字段无效');
  for(const list of [scan.errorDetails,scan.skipDetails])if(list!==undefined&&(!Array.isArray(list)||list.some(item=>!item||typeof item.path!=='string'||typeof item.reason!=='string')))throw new Error('错误明细字段无效');
  const map=new Map();
  for(const row of scan.directories){if(!row||typeof row.id!=='string'||map.has(row.id)||typeof row.path!=='string'||!numeric(row.bytes))throw new Error('目录索引格式无效或标识重复');optionalName(row);for(const key of ['ownBytes','omittedBytes'])if(row[key]!==undefined&&!numeric(row[key]))throw new Error('目录体积字段无效');for(const key of ['ownFileCount','fileDetailsCount','directErrors','directSkipped'])if(row[key]!==undefined&&!count(row[key]))throw new Error('目录计数字段无效');if(row.coverage!==undefined)validateCoverage(row.coverage);map.set(row.id,row);}
  if(map.size&&scan.directories.filter(row=>row.parentId==null).length!==1)throw new Error('目录树缺少唯一根目录');
  const checked=new Set();
  for(const node of scan.directories){let row=node;const seen=new Set();while(row&&!checked.has(row.id)){if(seen.has(row.id))throw new Error('目录树存在循环');seen.add(row.id);if(row.parentId==null)break;if(!map.has(String(row.parentId)))throw new Error('目录索引缺少父节点');row=map.get(String(row.parentId));}for(const id of seen)checked.add(id);}
  const validateFile=file=>{if(!file||typeof file.path!=='string'||!file.path||!numeric(file.bytes))throw new Error('文件索引格式无效');optionalName(file);};
  for(const file of scan.largeFiles)validateFile(file);
  if(scan.fileDetails!==undefined){
    if(!Array.isArray(scan.fileDetails)||scan.fileDetails.length>100000)throw new Error('目录文件明细超出范围');
    const seenFiles=new Set();
    for(const file of scan.fileDetails){validateFile(file);const parent=typeof file.parentId==='string'?map.get(file.parentId):null;if(!parent||directParent(file.path)!==norm(parent.path))throw new Error('文件明细父目录无效');const key=norm(file.path);if(seenFiles.has(key))throw new Error('文件明细路径重复');seenFiles.add(key);}
  }
  if(scan.fileDetailPolicy!==undefined){
    const policy=scan.fileDetailPolicy;
    if(!policy||typeof policy!=='object'||!['maxPerDirectory','maxTotal','retained','omitted'].every(key=>count(policy[key]))||policy.maxTotal>100000||policy.retained>(policy.maxTotal)||policy.retained!==(scan.fileDetails?.length||0))throw new Error('文件明细收录范围无效');
  }
  return true;
}

const canonicalTool=id=>id==='pnpm'?'pnpm-store':id;
const catalogByTool=new Map(catalog.map(rule=>[rule.tool,rule]));
const catalogTailRules=new Map([
  ['npm-cache',['npm']],['cache',['pip','uv','yarn']],['store',['pnpm-store']],
  ['pnpm-cache',['pnpm-cache']],['ms-playwright',['playwright']],['puppeteer',['puppeteer']],
  ['hub',['huggingface']],['hyperframes',['hyperframes']],['caches',['gradle']],['repository',['maven']],
].map(([tail,tools])=>[tail,tools.map(tool=>catalogByTool.get(tool))]));
function ruleForPath(path){const tail=path.slice(path.lastIndexOf('\\')+1),rules=catalogTailRules.get(tail)||(/^v\d+$/.test(tail)?[catalogByTool.get('pnpm-store'),catalogByTool.get('pnpm-cache')]:[]);return rules.find(rule=>rule.pattern.test(path));}
const toolPath=/^[a-z]:\\users\\[^\\]+\\(?:\.codex|\.workbuddy|\.marscode|\.qoder|\.codebuddy|\.vscode|\.zcode)$/;
const runtimePath=/^[a-z]:\\users\\[^\\]+\\\.cache\\codex-runtimes$/;
const documentPath=/\\users\\[^\\]+\\(?:documents|downloads|desktop)$/;
const baselinePath=/^[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata)$/;

export function createReportModel(state) {
  const scan=state.scan||{},rows=scan.directories||[];
  const normalizeFile=file=>({...file,name:file.name||String(file.path).split(/[\\/]/).at(-1)});
  const files=(scan.largeFiles||[]).map(normalizeFile);
  const byId=new Map(),byPath=new Map(),rowPaths=new Map(),childIndex=new Map(),known=new Map();
  const groups={tools:[],appData:[],documents:[],baselines:[]};
  let root;
  // Normalize each path once, and collect classifications in the same pass.
  for(const row of rows){
    const id=String(row.id),path=norm(row.path);
    byId.set(id,row);byPath.set(path,row);rowPaths.set(id,path);
    if(row.parentId==null){root??=row;}else{const parent=String(row.parentId);if(!childIndex.has(parent))childIndex.set(parent,[]);childIndex.get(parent).push(row);}
    const rule=ruleForPath(path);
    if(rule)known.set(path,{...rule,...row,name:rule.name,directoryName:row.name,id:'candidate:'+path,directoryId:row.id,exists:true,eligible:rule.risk!=='protected',source:'path',evidenceStatus:'path-hint',coverage:row.coverage,sizeIsPartial:row.coverage?row.coverage.status!=='complete':!scan.complete});
    if(toolPath.test(path)||runtimePath.test(path))groups.tools.push(row);
    else if(path.endsWith('\\appdata'))groups.appData.push(row);
    else if(documentPath.test(path))groups.documents.push(row);
    else if(baselinePath.test(path))groups.baselines.push(row);
  }
  root??=rows[0];
  for(const item of state.caches||[]){
    const path=norm(item.path),tool=canonicalTool(item.id),rule=catalogByTool.get(tool),row=byPath.get(path),previous=known.get(path);
    const custom=item.defaultPath?path!==norm(item.defaultPath):!rule?.pattern.test(path);
    const protectedItem=custom||!rule||rule.risk==='protected'||item.risk==='protected'||item.eligible===false||previous?.eligible===false;
    const exists=row?true:(typeof item.exists==='boolean'?item.exists:null);
    const fallback={tool,name:item.name||tool,risk:'protected',strategy:'先核验所属应用与实际生效路径，仅展示调查线索。',cost:'用途与可重建性未核验，保持保护。'};
    known.set(path,{...(previous||{}),...(rule||fallback),...item,tool,name:rule?.name||item.name||tool,id:'candidate:'+path,
      directoryId:row?.id,bytes:exists?(row?.bytes??item.bytes??null):null,exists,
      risk:protectedItem?'protected':rule.risk,eligible:exists===true&&!protectedItem,
      evidenceStatus:item.evidenceStatus||(item.source==='default'?'default-hint':item.source==='path'?'path-hint':'configured'),
      coverage:row?.coverage||item.coverage,sizeIsPartial:row?.coverage?row.coverage.status!=='complete':item.sizeIsPartial??!scan.complete,
      strategy:custom?'这是自定义配置目录，可能混有文档或用户数据。只展示调查线索，不生成缓存搬移建议。':rule?.strategy||fallback.strategy,
      cost:custom?'用途与可重建性未核验，保持保护。':rule?.cost||fallback.cost,
    });
  }
  // Keep every discovered location visible. Only the summary/category totals
  // collapse nested roots so that a nested store is not counted twice.
  const candidates=[...known.values()].sort((a,b)=>(b.bytes??-1)-(a.bytes??-1));
  const cacheRows=uniqueRoots(candidates.filter(item=>Number.isFinite(item.bytes)&&item.eligible!==false));
  const tools=uniqueRoots(groups.tools),appData=uniqueRoots(groups.appData),documents=uniqueRoots(groups.documents),baselines=uniqueRoots(groups.baselines);
  const claims=new Map();
  for(const [id,items] of [['baseline',baselines],['documents',documents],['application-data',appData],['tools',tools],['caches',cacheRows]])
    for(const item of items){const row=byPath.get(norm(item.path));if(row)claims.set(String(row.id),id);}
  const categoryCache=new Map();
  const category=id=>{const cacheKey=String(id);if(claims.has(cacheKey))return claims.get(cacheKey);if(categoryCache.has(cacheKey))return categoryCache.get(cacheKey);let row=byId.get(cacheKey),kind='other';const parentKey=String(row?.parentId),inherited=claims.get(parentKey)||categoryCache.get(parentKey);if(row?.parentId==null||inherited){const value=inherited||'other';categoryCache.set(cacheKey,value);return value;}const chain=[],seen=new Set();while(row){const key=String(row.id);if(claims.has(key)){kind=claims.get(key);break;}if(categoryCache.has(key)){kind=categoryCache.get(key);break;}if(seen.has(key))break;seen.add(key);chain.push(key);row=byId.get(String(row.parentId));}for(const key of chain)categoryCache.set(key,kind);return kind;};
  const totals=new Map();
  for(const row of rows){const id=category(row.id);totals.set(id,(totals.get(id)||0)+(Number(row.ownBytes)||0)+(Number(row.omittedBytes)||0));}
  const sum=id=>totals.get(id)||0,findings=[];
  const add=(id,title,items,bytes,description,kind='finding')=>{if(bytes>0)findings.push({id,title,items,bytes,description,kind});};
  add('caches','开发依赖与浏览器缓存',cacheRows,sum('caches'),'先核验工具配置、重建条件与当前使用状态；体积不是可释放承诺。');
  add('tools','AI 工具、运行时与工作记录',tools,sum('tools'),'包含运行程序、会话、插件、工作区与历史，需要按用途核验，不能整目录视作缓存。');
  add('application-data','应用数据与离线内容',appData,sum('application-data'),'这里已扣除单独归类的缓存或工具目录，剩余可能含账号、数据库、聊天附件、配置和离线内容。');
  add('documents','用户文档、下载与桌面',documents,sum('documents'),'可能含唯一副本、安装包或归档；逐项确认来源和保留需求。');
  const accounted=findings.reduce((n,item)=>n+item.bytes,0)+sum('baseline');
  add('other','其他已统计内容',[],Math.max(0,(scan.totalBytes||root?.bytes||0)-accounted),'包含尚未归类的目录及直属文件；通过空间浏览进一步定位。');
  findings.sort((a,b)=>b.bytes-a.bytes);
  add('baseline','系统与已安装应用基线',baselines,sum('baseline'),'系统与应用安装成本作为基线展示。不要直接删除 Windows、Installer、WinSxS 或程序目录。','baseline');

  const childrenCache=new Map();
  const children=id=>{
    const key=String(id),row=byId.get(key);if(!row)return[];
    if(!childrenCache.has(key)){
      const result=[...(childIndex.get(key)||[])];
      if(row.ownBytes>0)result.push({id:`${id}:own`,parentId:row.id,name:'直属文件',path:row.path,bytes:row.ownBytes,type:'own'});
      if(row.omittedBytes>0)result.push({id:`${id}:omitted`,parentId:row.id,name:'快照中未保留的小目录',path:row.path,bytes:row.omittedBytes,type:'omitted'});
      childrenCache.set(key,result.sort((a,b)=>b.bytes-a.bytes));
    }
    return [...childrenCache.get(key)];
  };
  const trail=id=>{const result=[],seen=new Set();let row=byId.get(String(id));while(row&&!seen.has(String(row.id))){result.unshift(row);seen.add(String(row.id));row=byId.get(String(row.parentId));}return result;};
  const allFiles=new Map(),directFiles=new Map();
  for(const file of [...files,...(scan.fileDetails||[]).map(normalizeFile)])allFiles.set(norm(file.path),file);
  for(const [path,file] of allFiles){const parent=path.slice(0,path.lastIndexOf('\\'));if(!directFiles.has(parent))directFiles.set(parent,[]);directFiles.get(parent).push(file);}
  for(const items of directFiles.values())items.sort((a,b)=>b.bytes-a.bytes);
  const filesIn=(directory,direct=false)=>{
    const path=norm(directory);if(direct)return directFiles.get(path)||[];
    const start=byPath.get(path);if(!start)return [...allFiles].filter(([key])=>key===path||key.startsWith(path+'\\')).map(([,file])=>file).sort((a,b)=>b.bytes-a.bytes);
    const result=[],stack=[start];
    while(stack.length){const node=stack.pop();result.push(...(directFiles.get(rowPaths.get(String(node.id)))||[]));for(const child of childIndex.get(String(node.id))||[])stack.push(child);}
    return result.sort((a,b)=>b.bytes-a.bytes);
  };
  const fileCoverage=id=>{const row=byId.get(String(id)),retained=row?(directFiles.get(rowPaths.get(String(id)))?.length||0):0,total=Number.isSafeInteger(row?.ownFileCount)?row.ownFileCount:null,legacy=!Array.isArray(scan.fileDetails);return {retained,total,limited:total==null||retained<total,legacy,coverage:row?.coverage};};
  let sortedRows,queryCache={query:null,items:[]};
  const getDirectoryRows=(query='',limit=80)=>{
    sortedRows??=rows.filter(item=>item.parentId!=null).sort((a,b)=>b.bytes-a.bytes);
    const needle=norm(String(query).trim());
    if(queryCache.query!==needle)queryCache={query:needle,items:needle?sortedRows.filter(row=>rowPaths.get(String(row.id)).includes(needle)):sortedRows};
    const count=Math.max(0,Math.min(Number.isFinite(limit)?Math.floor(limit):80,500000));
    return {items:queryCache.items.slice(0,count),total:queryCache.items.length,hasMore:queryCache.items.length>count};
  };
  const recommendation=(id,title,description,items,action)=>({id,title,description,items,bytes:items.reduce((n,item)=>n+(item.bytes||0),0),action});
  const recommendations=[
    recommendation('check','优先检查下载与大文件','先确认是否仍需保留安装包、归档与个人下载，逐项查看，不自动删除。',documents,'browse'),
    recommendation('official','通过 Windows 或应用设置处理','系统和程序目录优先使用 Windows 存储设置、应用卸载或应用自身的管理功能。',baselines,'about'),
    recommendation('relocate','适合核验存储位置','以下缓存线索可先确认实际路径，再评估切换到非系统盘；体积不等于可释放量。',cacheRows,'migration'),
    recommendation('keep','暂时保留应用状态和记录','保护账号、会话、数据库、文档与未发布构件；混合应用数据先调查用途。',uniqueRoots([...tools,...candidates.filter(item=>item.risk==='protected'&&item.exists!==false)]),'browse'),
  ];
  return {scan,rows,files,byId,byPath,childIndex,root,children,trail,filesIn,fileCoverage,getDirectoryRows,candidates,findings,recommendations,cacheSummary:summarizeCacheCandidates(candidates)};
}

export function compareSnapshots(previous,current) {
  const before=previous?.scan,after=current?.scan;
  const result={compatible:false,reason:'',previousAt:before?.finishedAt||before?.startedAt||null,currentAt:after?.finishedAt||after?.startedAt||null,partial:!before?.complete||!after?.complete||!!before?.displayPruned||!!after?.displayPruned,changes:[],measurement:'logical-bytes'};
  if(!before||!after||typeof before.root!=='string'||!before.root||typeof after.root!=='string'||!after.root||norm(before.root)!==norm(after.root)){result.reason='两份快照的扫描根目录不同，不能直接比较。';return result;}
  if((before.measurement||'logical-bytes')!==(after.measurement||'logical-bytes')){result.reason='两份快照的统计口径不同，不能直接比较。';return result;}
  const byPath=new Map((before.directories||[]).map(row=>[norm(row.path),row]));
  const changes=[];
  for(const row of after.directories||[]){
    const earlier=byPath.get(norm(row.path));
    // Only compare directories present in both snapshots. An absent directory
    // could be omitted or unreadable and must never be treated as zero bytes.
    if(!earlier)continue;
    const deltaBytes=row.bytes-earlier.bytes;
    if(deltaBytes!==0)changes.push({path:row.path,name:row.name||String(row.path).split(/[\\/]/).at(-1),beforeBytes:earlier.bytes,afterBytes:row.bytes,deltaBytes});
  }
  changes.sort((a,b)=>b.deltaBytes-a.deltaBytes);
  result.compatible=true;result.reason='仅比较两份快照都保留的目录；父子目录变化可能重叠，不可相加为释放空间。';result.changes=changes.slice(0,20);result.measurement=after.measurement||'logical-bytes';return result;
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
