export function formatBytes(value) {
  if (value == null || !Number.isFinite(Number(value))) return '未统计';
  const n = Math.max(0, Number(value));
  const unit = Math.min(4, Math.floor(Math.log(n || 1) / Math.log(1024)));
  return `${(n / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: unit ? 1 : 0 })} ${['B','KiB','MiB','GiB','TiB'][unit]}`;
}

export function directoryChildren(rows, id) {
  const node = rows.find(item => item.id === id);
  const children = rows.filter(item => item.parentId === id && item.id !== id).map(item=>({...item}));
  if (node?.ownBytes > 0) children.push({id:`${id}:own`,name:'直属文件',path:node.path,bytes:node.ownBytes,synthetic:true});
  if (node?.omittedBytes > 0) children.push({id:`${id}:omitted`,name:'已折叠的小目录',path:node.path,bytes:node.omittedBytes,synthetic:true});
  return children.filter(item=>item.bytes>0).sort((a,b)=>b.bytes-a.bytes);
}

export function exportSnapshot(state) {
  return {exportedAt:new Date().toISOString(),scope:'本机磁盘分析报告；文件路径可能包含个人信息',version:state.version,drives:state.drives,scan:state.scan,caches:state.caches,history:state.history,operations:state.operations};
}

export function partition(items, x=0, y=0, width=100, height=100) {
  const sum = items.reduce((value,item)=>value+item.bytes,0);
  if (!sum || !items.length) return [];
  if (items.length===1) return [{...items[0],x,y,width,height}];
  let split=1, partial=items[0].bytes;
  while(split<items.length-1 && partial<sum/2) partial+=items[split++].bytes;
  const ratio=partial/sum;
  return width*1.6>height
    ? [...partition(items.slice(0,split),x,y,width*ratio,height),...partition(items.slice(split),x+width*ratio,y,width*(1-ratio),height)]
    : [...partition(items.slice(0,split),x,y,width,height*ratio),...partition(items.slice(split),x,y+height*ratio,width,height*(1-ratio))];
}

export const operationLabels = {migrate:'缓存迁移',isolate:'隔离缓存',restore:'恢复隔离',rollback:'回退缓存配置'};
export const statusLabels = {idle:'尚未扫描',running:'进行中',completed:'已完成',cancelled:'已取消',failed:'失败',interrupted:'已中断',success:'成功',info:'信息',warning:'需留意'};
export const dateLabel = value => value ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '—';
export const metricCount = value => Array.isArray(value) ? value.length : Number(value || 0);
export const sourceLabel = value => ({default:'工具默认位置（尚未验证生效配置）',environment:'环境变量',config:'配置文件'})[value] || value || '路径待核验';
