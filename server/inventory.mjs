import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const envValue = (env, key) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
const expand = (value, env, home) => value.replace(/^~(?=[\\/]|$)/, home).replace(/\$\{([^}]+)\}|%([^%]+)%/g, (whole, a, b) => envValue(env, a || b) || whole);

async function readSetting(file, wanted, section = null) {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return { uncertain: true };
    const text = await fs.readFile(file, 'utf8');
    let active = null;
    let result;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || /^[#;]/.test(trimmed)) continue;
      const matchSection = /^\[([^\]]+)\]$/.exec(trimmed);
      if (matchSection) { active = matchSection[1].toLowerCase(); continue; }
      const match = /^([^=]+)=(.*)$/.exec(trimmed);
      if (match && match[1].trim().toLowerCase() === wanted && (!section || active === section)) {
        result = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      }
    }
    return { value: result };
  } catch (error) {
    return { uncertain: error.code !== 'ENOENT' };
  }
}

export async function discoverCaches({ env = process.env, home = os.homedir() } = {}) {
  const local = envValue(env, 'LOCALAPPDATA') || path.join(home, 'AppData', 'Local');
  const roaming = envValue(env, 'APPDATA') || path.join(home, 'AppData', 'Roaming');
  const definitions = [
    { id: 'npm', name: 'npm 缓存', path: path.join(local, 'npm-cache'), envKey: 'NPM_CONFIG_CACHE', supported: true,
      strategy: '复制并校验缓存后设置当前用户 NPM_CONFIG_CACHE。原副本保留；重启终端后核验 npm config get cache。包含 _npx 临时运行环境，操作前关闭相关工具。' },
    { id: 'pip', name: 'pip 缓存', path: path.join(local, 'pip', 'Cache'), envKey: 'PIP_CACHE_DIR', supported: true,
      strategy: '复制并校验后设置当前用户 PIP_CACHE_DIR；新终端运行 pip cache dir 核验。重新下载依赖需要网络。' },
    { id: 'uv', name: 'uv 缓存', path: path.join(local, 'uv', 'cache'), envKey: 'UV_CACHE_DIR', supported: true,
      strategy: '复制并校验后设置当前用户 UV_CACHE_DIR。跨卷硬链接会退化为复制，安装可能变慢；包含符号链接时自动操作会拒绝。' },
    { id: 'pnpm', name: 'pnpm store', path: path.join(local, 'pnpm', 'store'), envKey: '', supported: false,
      strategy: '人工规划：使用 pnpm store path 核验；按项目所在卷设置 store-dir，保留旧 store 并重新安装验证。跨卷不能使用原有硬链接，第一版不自动修改。' },
    { id: 'gradle', name: 'Gradle 缓存', path: path.join(envValue(env, 'GRADLE_USER_HOME') || path.join(home, '.gradle'), 'caches'), envKey: '', supported: false,
      strategy: '人工规划：停止 Gradle daemon 后，仅迁移已确认的 caches。GRADLE_USER_HOME 包含凭据、配置、包装器等，不能把整个目录视作缓存清理。' },
    { id: 'playwright', name: 'Playwright 浏览器', path: envValue(env, 'PLAYWRIGHT_BROWSERS_PATH') || path.join(local, 'ms-playwright'), envKey: '', supported: false,
      strategy: '人工规划：设置 PLAYWRIGHT_BROWSERS_PATH 后通过官方安装命令重建浏览器，再验证自动化项目。新位置会影响各项目使用的浏览器版本。' },
    { id: 'maven', name: 'Maven 本地仓库', path: path.join(home, '.m2', 'repository'), envKey: '', supported: false,
      strategy: '仅供查看：本地仓库可能包含未发布的私有构件。备份 settings.xml 和唯一构件后，再规划 localRepository；不提供通用清理。' },
  ];
  const npmConfigPath = envValue(env, 'NPM_CONFIG_USERCONFIG') || path.join(home, '.npmrc');
  const npmSetting = await readSetting(npmConfigPath, 'cache');
  const pipPaths = [path.join(envValue(env, 'PROGRAMDATA') || 'C:\\ProgramData', 'pip', 'pip.ini'), path.join(home, 'pip', 'pip.ini'), path.join(roaming, 'pip', 'pip.ini')];
  if (envValue(env, 'VIRTUAL_ENV')) pipPaths.push(path.join(envValue(env, 'VIRTUAL_ENV'), 'pip.ini'));
  if (envValue(env, 'PIP_CONFIG_FILE')) pipPaths.push(envValue(env, 'PIP_CONFIG_FILE'));
  let pipSetting = {};
  for (const file of pipPaths) {
    const setting = await readSetting(file, 'cache-dir', 'global');
    pipSetting = { value: setting.value ?? pipSetting.value, uncertain: setting.uncertain || pipSetting.uncertain };
  }
  const uvConfigs = [path.join(roaming, 'uv', 'uv.toml'), path.join(home, '.config', 'uv', 'uv.toml')];
  let uvSetting = {};
  for (const file of uvConfigs) {
    const setting = await readSetting(file, 'cache-dir');
    uvSetting = { value: setting.value ?? uvSetting.value, uncertain: setting.uncertain || uvSetting.uncertain };
  }
  const settings = { npm: npmSetting, pip: pipSetting, uv: uvSetting };
  return Promise.all(definitions.map(async definition => {
    const candidate = { ...definition, defaultPath: definition.path, bytes: null, exists: false, source: 'default', warnings: [] };
    if ((candidate.id === 'playwright' && envValue(env, 'PLAYWRIGHT_BROWSERS_PATH')) || (candidate.id === 'gradle' && envValue(env, 'GRADLE_USER_HOME'))) candidate.source = 'environment';
    const setting = settings[candidate.id];
    const configured = candidate.envKey ? envValue(env, candidate.envKey) : null;
    if (configured) { candidate.path = expand(configured, env, home); candidate.source = 'environment'; }
    else if (setting?.value) { candidate.path = expand(setting.value, env, home); candidate.source = 'config'; }
    if (!path.isAbsolute(candidate.path) || /[\0\r\n]/.test(candidate.path) || /^(?:\\\\|\/\/)/.test(candidate.path)) {
      candidate.supported = false;
      candidate.warnings.push('配置不是受支持的本地绝对目录，需手动核验。');
    } else {
      candidate.path = path.resolve(candidate.path);
      try {
        const info = await fs.lstat(candidate.path);
        candidate.exists = info.isDirectory() && !info.isSymbolicLink();
        if (info.isSymbolicLink()) { candidate.supported = false; candidate.warnings.push('该位置为链接，自动操作已禁用。'); }
      } catch (error) {
        if (error.code !== 'ENOENT') candidate.warnings.push(`无法访问：${error.code}`);
      }
    }
    if (candidate.supported && !samePath(candidate.path, candidate.defaultPath)) {
      candidate.supported = false;
      candidate.warnings.push('自定义缓存目录可能混有用户数据，第一版仅提供策略，不自动迁移或隔离。');
    }
    if (setting?.uncertain) { candidate.supported = false; candidate.warnings.push('部分配置无法安全读取，自动操作已禁用。'); }
    candidate.warnings.push(candidate.source === 'default' ? '此路径是工具默认位置，不等于已核验当前生效配置；项目、命令行参数或其他终端可能覆盖它。' : '配置来自当前进程环境或已读取的用户配置；项目和命令行参数仍可能覆盖。');
    if (!candidate.exists) candidate.warnings.push('目录不存在或无法读取；完成扫描后再核验。');
    return candidate;
  }));
}

export async function getInventory() {
  const caches = await discoverCaches();
  let drives = [];
  if (process.platform === 'win32') {
    const script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -eq [System.IO.DriveType]::Fixed } | ForEach-Object { [pscustomobject]@{ id=$_.Name.Substring(0,2); label=$_.VolumeLabel; path=$_.Name; totalBytes=$_.TotalSize; freeBytes=$_.AvailableFreeSpace; isSystem=($_.Name.Substring(0,2) -eq $env:SystemDrive) } }) | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
    const value = JSON.parse(stdout.replace(/^\uFEFF/, '') || '[]');
    drives = (Array.isArray(value) ? value : [value]).map(drive => ({ ...drive, label: drive.label || `本地磁盘 (${drive.id})` }));
  } else {
    const stat = await fs.statfs('/');
    drives = [{ id: '/', label: '本地文件系统', path: '/', totalBytes: stat.blocks * stat.bsize, freeBytes: stat.bavail * stat.bsize, isSystem: true }];
  }
  return { drives, caches };
}
