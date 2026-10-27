import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
const run = promisify(execFile);
const manifestScript = fileURLToPath(new URL('./manifest.py', import.meta.url));
export const normalize = value => path.resolve(value).toLowerCase();
export const samePath = (a,b) => normalize(a) === normalize(b);
export const inside = (child,parent) => {const relative=path.relative(normalize(parent),normalize(child));return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));};

export function localPath(value) {
  if(typeof value!=='string'||!value||!path.isAbsolute(value)||/[\x00-\x1f]/.test(value)||value.startsWith('\\\\')||value.startsWith('//')) throw new Error('仅支持本机绝对路径');
  if(process.platform==='win32'&&(!/^[a-z]:[\\/]/i.test(value)||value.slice(2).includes(':')||value.split(/[\\/]/).some(x=>/[. ]$/.test(x)))) throw new Error('不支持此 Windows 路径格式');
  return path.resolve(value);
}
export async function exists(value) {try {await fs.lstat(value);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export async function manifest(value,validateOnly=false) {
  const args=['-I',manifestScript,localPath(value),...(validateOnly?['validate']:[])];
  let stdout;
  try {({stdout}=await run('python',args,{windowsHide:true,timeout:120000,maxBuffer:64*1024*1024,encoding:'utf8'}));}
  catch(e){let detail;try{detail=JSON.parse(e.stdout).error;}catch{}throw new Error(detail||'无法完成文件安全检查，请确认 Python 3 可用且目录可访问');}
  const result=JSON.parse(stdout);if(result.error)throw new Error(result.error);
  if(!validateOnly)result.fingerprint=createHash('sha256').update(JSON.stringify(result.entries)).digest('hex');
  return result;
}
export async function unchanged(value,expected) {const actual=await manifest(value);if(actual.fingerprint!==expected.fingerprint)throw new Error('目录内容或身份已变化，请重新生成计划');return actual;}
async function hashFile(value) {const hash=createHash('sha256');for await(const part of createReadStream(value))hash.update(part);return hash.digest('hex');}
async function restrictDirectory(value) {
  if(process.platform!=='win32'){await fs.chmod(value,0o700);return;}
  const script="$ErrorActionPreference='Stop';$acl=New-Object System.Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);$sids=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'));foreach($sid in $sids){$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($rule)};$item=Get-Item -LiteralPath $env:LIUBAI_TARGET;$item.SetAccessControl($acl);if(-not $item.GetAccessControl().AreAccessRulesProtected){throw 'ACL protection failed'}";
  await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,env:{...process.env,LIUBAI_TARGET:value},encoding:'utf8'});
}
export async function verifiedCopy(source,target,snapshot,onProgress=()=>{}) {
  if(await exists(target))throw new Error('目标目录已存在，拒绝覆盖');
  await manifest(path.dirname(target),true);
  await unchanged(source,snapshot);
  await fs.mkdir(target);
  await restrictDirectory(target);
  let copied=0,files=0;
  for(const entry of snapshot.entries.filter(e=>e.directory).sort((a,b)=>a.rel.length-b.rel.length)) {
    if(entry.rel==='.')continue;
    await fs.mkdir(path.join(target,entry.rel));
  }
  for(const entry of snapshot.entries.filter(e=>!e.directory)) {
    const from=path.join(source,entry.rel),to=path.join(target,entry.rel);
    // Never overwrite an existing file. Full pre/post snapshots reject concurrent cache changes.
    await fs.copyFile(from,to,1);
    if(await hashFile(from)!==await hashFile(to))throw new Error('复制后的 SHA-256 校验失败，原副本已保留');
    copied+=entry.size;files++;onProgress({copiedBytes:copied,copiedFiles:files});
  }
  await unchanged(source,snapshot);
  const destination=await manifest(target);
  if(destination.bytes!==snapshot.bytes||destination.fileCount!==snapshot.fileCount)throw new Error('目标副本统计不一致，原副本已保留');
  return destination;
}

const ENV_KEYS = new Set(['NPM_CONFIG_CACHE','PIP_CACHE_DIR','UV_CACHE_DIR']);
export const userEnvironment = {
  async read(key) {
    if(!ENV_KEYS.has(key))throw new Error('不允许此配置项');
    const script="[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $v=[Environment]::GetEnvironmentVariable($env:LIUBAI_KEY,'User'); @{value=$v}|ConvertTo-Json -Compress";
    const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,env:{...process.env,LIUBAI_KEY:key},encoding:'utf8'});
    return JSON.parse(stdout.replace(/^\uFEFF/, '')).value??null;
  },
  async write(key,value) {
    if(!ENV_KEYS.has(key))throw new Error('不允许此配置项');
    const script="$v=if($env:LIUBAI_REMOVE -eq '1'){$null}else{$env:LIUBAI_VALUE};[Environment]::SetEnvironmentVariable($env:LIUBAI_KEY,$v,'User')";
    await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,env:{...process.env,LIUBAI_KEY:key,LIUBAI_VALUE:value??'',LIUBAI_REMOVE:value===null?'1':'0'},encoding:'utf8'});
    const actual=await this.read(key);if(actual!==value)throw new Error('配置写入后的回读核验失败');
  }
};
