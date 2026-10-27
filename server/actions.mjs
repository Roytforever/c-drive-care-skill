import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exists, inside, localPath, manifest, samePath, unchanged, userEnvironment, verifiedCopy } from './safety.mjs';

const variables={npm:'NPM_CONFIG_CACHE',pip:'PIP_CACHE_DIR',uv:'UV_CACHE_DIR'};
export async function createActionManager({stateDir,getInventory,allowedRoots,systemRoot=process.env.SystemDrive+'\\',config=userEnvironment}) {
  const journalPath=path.join(stateDir,'journal.json');
  await fs.mkdir(stateDir,{recursive:true});
  await manifest(stateDir,true);
  let state={operations:[],history:[]};
  try {state=JSON.parse(await fs.readFile(journalPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('操作记录无法读取，已停止服务以保护恢复信息');}
  const plans=new Map();let active=null,planning=false,saveQueue=Promise.resolve();
  const save=()=>{const next=saveQueue.catch(()=>{}).then(async()=>{const temporary=journalPath+'.tmp';await fs.writeFile(temporary,JSON.stringify(state,null,2),{mode:0o600});await fs.rename(temporary,journalPath);});saveQueue=next;return next;};
  for(const op of state.operations)if(op.status==='running'){op.status='interrupted';op.error='上次服务中断。请检查原目录、目标副本和配置；不会自动继续操作。';}
  await save();
  const record=(title,detail,status='info')=>state.history.unshift({id:randomUUID(),title,detail,status,time:new Date().toISOString()});
  const publicPlan=plan=>{const {snapshot,previousConfig,relatedSnapshot,...result}=plan;return result;};
  function assertIdle(){if(active||planning)throw new Error('另一项操作或计划正在进行，请等待完成');}
  async function plan(request) {
    assertIdle();planning=true;
    try {
      for(const [id,p] of plans)if(Date.parse(p.expiresAt)<Date.now())plans.delete(id);
      if(plans.size>30)plans.clear();
      const {kind}=request;
      if(!['migrate','isolate','restore','rollback'].includes(kind))throw new Error('不支持的操作');
      const id=randomUUID();const result={id,kind,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+10*60000).toISOString(),warnings:[],steps:[],releasedBytes:0};
      if(kind==='migrate'||kind==='isolate') {
        const inventory=await getInventory();const cache=inventory.caches.find(c=>c.id===request.cacheId);
        if(!cache||!cache.supported||!variables[cache.id]||!allowedRoots[cache.id]||!samePath(cache.path,allowedRoots[cache.id]))throw new Error('此路径不在第一版自动操作允许范围内，请使用手动策略');
        result.source=localPath(cache.path);result.cacheId=cache.id;result.cacheName=cache.name;
        result.snapshot=await manifest(result.source);
        if(!result.snapshot.entries[0]||!result.snapshot.entries.find(e=>e.rel==='.')?.directory)throw new Error('缓存必须是目录');
        result.bytes=result.snapshot.bytes;result.fileCount=result.snapshot.fileCount;
        if(kind==='migrate') {
          const drive=inventory.drives.find(d=>d.id===request.driveId);
          if(!drive||drive.isSystem||samePath(drive.path,systemRoot)||inside(result.source,drive.path))throw new Error('迁移必须选择不同的非系统盘');
          if(drive.freeBytes<result.bytes+512*1024*1024)throw new Error('目标盘剩余空间不足，需保留至少 512 MiB 余量');
          const destination=localPath(drive.path);await manifest(destination,true);
          result.target=path.join(destination,'LiubaiCaches',cache.id+'-'+id.slice(0,8));
          if(inside(result.target,result.source)||inside(result.source,result.target))throw new Error('源目录与目标目录不能互相包含');
          if(await exists(result.target))throw new Error('目标目录已存在，拒绝覆盖');
          result.envKey=variables[cache.id];result.previousConfig=await config.read(result.envKey);
          result.configChange={key:result.envKey,scope:'当前用户环境变量',before:result.previousConfig,after:result.target};
          result.steps=['只复制缓存，保留原目录','逐文件 SHA-256 校验并复核源目录未变化','保存并切换当前用户缓存环境变量','重启终端和所属工具后，自行验证使用新缓存'];
          result.warnings=['请先关闭安装、构建和使用此缓存的程序。','仅对之后启动且继承新环境的进程生效；命令行参数可覆盖环境变量。','原副本保留，迁移结束时 C 盘释放量为 0。配置回退不会删除任一副本。','已有进程、系统或父进程环境可能继续使用旧路径；重启工具后验证。'];
        } else {
          result.target=path.join(path.dirname(result.source),'.liubai-isolated-'+cache.id+'-'+id.slice(0,8));
          result.steps=['复核目录内容与预览一致','在同一位置旁重命名隔离','记录原路径与隔离路径，提供恢复入口'];
          result.warnings=['这是可恢复隔离，不是永久删除；不会释放磁盘空间。','请关闭所属工具。重新运行工具可能重新下载缓存，甚至重建原目录。','恢复时原路径必须不存在。需要真正删除时，请先验证工具可用，再在资源管理器中人工处理隔离目录。'];
        }
      } else {
        const related=state.operations.find(o=>o.id===request.operationId&&o.status==='completed');
        if(!related||related.revertedBy)throw new Error('没有可恢复的操作记录');
        result.relatedId=related.id;result.cacheId=related.cacheId;result.cacheName=related.cacheName;result.bytes=related.bytes;result.fileCount=related.fileCount;
        if(kind==='restore') {
          if(related.kind!=='isolate')throw new Error('该记录不是隔离操作');
          result.source=related.target;result.target=related.source;
          if(await exists(result.target))throw new Error('原路径已存在或被占用，禁止覆盖恢复');
          result.snapshot=await manifest(result.source);
          result.bytes=result.snapshot.bytes;result.fileCount=result.snapshot.fileCount;
          result.steps=['复核隔离目录','确认原路径未被重新创建','将隔离目录恢复到原位置'];
          result.warnings=['请先关闭所属工具；不会覆盖或合并任何已存在目录。'];
        } else {
          if(related.kind!=='migrate')throw new Error('该记录不是迁移操作');
          result.source=related.target;result.target=related.source;result.envKey=related.envKey;result.previousConfig=related.previousConfig;
          if(await config.read(result.envKey)!==related.target)throw new Error('当前环境配置已改变，不能覆盖回退');
          result.snapshot=await manifest(result.target);
          result.configChange={key:result.envKey,scope:'当前用户环境变量',before:related.target,after:related.previousConfig};
          result.steps=['核验原目录仍存在','恢复迁移前的用户环境变量','保留原目录和目标副本'];
          result.warnings=['仅回退环境配置；两份缓存均保留。请重启终端与工具后验证。'];
        }
      }
      result.confirmationText=({migrate:'迁移',isolate:'隔离',restore:'恢复',rollback:'回退'})[kind]+' '+(result.cacheName||result.cacheId);
      plans.set(id,result);return publicPlan(result);
    } finally {planning=false;}
  }
  async function execute(input) {
    assertIdle();const plan=plans.get(input.planId);
    if(!plan||Date.parse(plan.expiresAt)<Date.now())throw new Error('确认计划已失效或已使用，请重新生成');
    if(input.acknowledged!==true||input.confirmationText!==plan.confirmationText)throw new Error('必须完整阅读并输入确认文字');
    plans.delete(plan.id);
    const op={...publicPlan(plan),id:randomUUID(),planId:plan.id,status:'running',stage:'准备',startedAt:new Date().toISOString(),previousConfig:plan.previousConfig,copiedBytes:0};
    state.operations.unshift(op);record('已确认'+plan.confirmationText,plan.source+' → '+plan.target);
    // Reserve the executor before the first await. The write-ahead journal must precede side effects.
    active=(async()=>{
      try {
        await save();
        if(plan.kind==='migrate') {
          if(await config.read(plan.envKey)!==plan.previousConfig)throw new Error('环境配置在预览后已变化，请重新规划');
          const inventory=await getInventory();const volume=inventory.drives.find(d=>inside(plan.target,d.path));
          if(!volume||volume.isSystem||volume.freeBytes<plan.bytes+512*1024*1024)throw new Error('目标盘不可用或空间不足');
          const parent=path.dirname(plan.target);await manifest(path.dirname(parent),true);
          if(!await exists(parent))await fs.mkdir(parent);
          await manifest(parent,true);
          op.stage='复制并校验';await save();
          await verifiedCopy(plan.source,plan.target,plan.snapshot,progress=>Object.assign(op,progress));
          op.stage='副本已校验，准备切换配置';await save();
          if(await config.read(plan.envKey)!==plan.previousConfig)throw new Error('复制期间环境配置已变化；保留两份缓存，拒绝覆盖设置');
          await config.write(plan.envKey,plan.target);
          op.stage='复制及配置切换完成，等待工具验证';
        } else if(plan.kind==='isolate'||plan.kind==='restore') {
          await manifest(path.dirname(plan.target),true);
          if(await exists(plan.target))throw new Error('目标路径已存在，拒绝覆盖');
          await unchanged(plan.source,plan.snapshot);
          op.stage='准备重命名隔离/恢复';await save();
          await fs.rename(plan.source,plan.target);
          op.stage=plan.kind==='isolate'?'已隔离，尚未释放空间':'已恢复';
        } else {
          if(await config.read(plan.envKey)!==plan.source)throw new Error('当前配置已改变，拒绝覆盖回退');
          await unchanged(plan.target,plan.snapshot);
          op.stage='准备恢复配置';await save();await config.write(plan.envKey,plan.previousConfig);op.stage='配置已回退';
        }
        op.status='completed';if(plan.relatedId){const related=state.operations.find(x=>x.id===plan.relatedId);related.revertedBy=op.id;}
        record(op.stage,`${op.source} → ${op.target}；实际释放 0 字节。`,'success');
      } catch(error) {op.status='failed';op.error=error.message;record('操作未完成',`${error.message}。请核对记录中的路径；不会自动删除残留副本。`,'warning');}
      finally {op.finishedAt=new Date().toISOString();try{await save();}catch(error){op.status='failed';op.error='记录保存失败：'+error.message;}active=null;}
    })();
    return {operationId:op.id};
  }
  return {plan,execute,getState:()=>({...structuredClone(state),plans:[...plans.values()].filter(p=>Date.parse(p.expiresAt)>Date.now()).map(publicPlan)}),waitForIdle:async()=>{if(active)await active;await saveQueue;},addHistory:async(title,detail,status='info')=>{record(title,detail,status);if(!active)await save();}};
}
