const dir = (id, name, path, size, color, children = [], protectedItem = false) => ({ id, name, path, size, color, children, protected: protectedItem });
export const rootDirectory = dir('root', 'Windows (C:)', 'C:\\', 403.6, '#155e4c', [
  dir('users', '用户目录', 'C:\\Users', 218.4, '#176b59', [
    dir('local', 'AppData', 'C:\\Users\\Demo\\AppData', 128.6, '#176b59', [
      dir('localdata', 'Local', 'C:\\Users\\Demo\\AppData\\Local', 111.2, '#176b59'),
      dir('roaming', 'Roaming', 'C:\\Users\\Demo\\AppData\\Roaming', 17.4, '#6d9c81'),
    ]),
    dir('projects', '项目文件', 'C:\\Users\\Demo\\Projects', 27.8, '#568e78', [], true),
    dir('maven', 'Maven 本地仓库', 'C:\\Users\\Demo\\.m2', 24.6, '#8ead8e', [], true),
    dir('documents', '文档', 'C:\\Users\\Demo\\Documents', 19.2, '#bfd1b7', [], true),
    dir('downloads', '下载目录', 'C:\\Users\\Demo\\Downloads', 18.2, '#e6c575'),
  ]),
  dir('apps', '应用程序', 'C:\\Program Files', 96.2, '#80a785', [
    dir('dev-apps', '开发应用', 'C:\\Program Files\\Development', 38.2, '#80a785', [], true),
    dir('ms-apps', 'Microsoft', 'C:\\Program Files\\Microsoft', 22.4, '#91b096', [], true),
    dir('adobe', 'Adobe', 'C:\\Program Files\\Adobe', 18.6, '#aac3a2', [], true),
    dir('other-apps', '其他应用', 'C:\\Program Files\\其他应用', 17, '#c5d5ba', [], true),
  ], true),
  dir('windows', 'Windows', 'C:\\Windows', 61.8, '#e8c879', [
    dir('winsxs', 'WinSxS', 'C:\\Windows\\WinSxS', 24.2, '#e8c879', [], true),
    dir('system32', 'System32', 'C:\\Windows\\System32', 19.8, '#eed596', [], true),
    dir('system-other', '其他系统文件', 'C:\\Windows\\其他系统文件', 17.8, '#f3e3b9', [], true),
  ], true),
  dir('tools', '开发工具', 'C:\\DevTools', 18.6, '#b6d3a5', [
    dir('sdk', 'SDK 与工具链', 'C:\\DevTools\\SDK', 12.4, '#b6d3a5', [], true),
    dir('build', '构建产物', 'C:\\DevTools\\Build', 6.2, '#c9ddbc'),
  ]),
  dir('other', '其他', 'C:\\其他直属文件', 8.6, '#d0d5d3', [], true),
]);

export const locations = [
  { id:'local', path:'C:\\Users\\Demo\\AppData\\Local', type:'应用数据', size:111.2, advice:'进一步分析', target:'users' },
  { id:'apps', path:'C:\\Program Files', type:'应用程序', size:96.2, advice:'保留', protected:true, target:'apps' },
  { id:'windows', path:'C:\\Windows', type:'系统文件', size:61.8, advice:'系统保护', protected:true, target:'windows' },
  { id:'projects', path:'C:\\Users\\Demo\\Projects', type:'用户文件', size:27.8, advice:'人工核验', protected:true, target:'users' },
  { id:'maven', path:'C:\\Users\\Demo\\.m2', type:'混合数据', size:24.6, advice:'分类核验', protected:true, target:'users' },
  { id:'downloads', path:'C:\\Users\\Demo\\Downloads', type:'下载文件', size:18.2, advice:'人工确认', target:'users' },
];

export const largeFiles = [
  { id:'f1', name:'Ubuntu-24.04-desktop-amd64.iso', path:'C:\\Users\\Demo\\Downloads\\Ubuntu-24.04-desktop-amd64.iso', type:'镜像文件', size:5.8, date:'2026-09-16', risk:'review', note:'下载的安装镜像。需要确认是否还用于虚拟机或安装介质。' },
  { id:'f2', name:'ext4.vhdx', path:'C:\\Users\\Demo\\AppData\\Local\\Docker\\wsl\\disk\\ext4.vhdx', type:'虚拟磁盘', size:48.6, date:'2026-10-22', risk:'protected', note:'可能包含容器、数据库和卷数据。请通过 Docker 官方管理功能处理，不能作为缓存直接删除。' },
  { id:'f3', name:'project-archive-2025.zip', path:'C:\\Users\\Demo\\Documents\\project-archive-2025.zip', type:'用户文件', size:8.4, date:'2026-01-08', risk:'protected', note:'项目归档可能是唯一副本。体积或文件名都不能证明它可以删除。' },
  { id:'f4', name:'Android-Studio-installer.exe', path:'C:\\Users\\Demo\\Downloads\\Android-Studio-installer.exe', type:'安装介质', size:1.3, date:'2026-08-24', risk:'review', note:'先确认已完成安装且无需保留离线安装包。' },
  { id:'f5', name:'model-00001-of-00002.safetensors', path:'C:\\Users\\Demo\\.cache\\huggingface\\hub\\models--demo\\model-00001-of-00002.safetensors', type:'模型文件', size:7.2, date:'2026-10-18', risk:'review', note:'模型重新下载有网络、授权和耗时成本，需确认来源仍然可用。' },
  { id:'f6', name:'pagefile.sys', path:'C:\\pagefile.sys', type:'系统文件', size:8.0, date:'2026-10-22', risk:'protected', note:'Windows 分页文件。只能通过系统设置管理，原型不提供删除入口。' },
  { id:'f7', name:'backup-dev-db.sql', path:'C:\\Users\\Demo\\Documents\\backup-dev-db.sql', type:'用户文件', size:3.6, date:'2026-10-20', risk:'protected', note:'数据库备份属于用户数据。不能按扩展名、时间或体积推定可重建。' },
  { id:'f8', name:'design-assets.zip', path:'C:\\Users\\Demo\\Downloads\\design-assets.zip', type:'压缩文件', size:2.1, date:'2026-10-10', risk:'review', note:'确认压缩包内容与解压后的文件均已妥善保存后，再决定如何处理。' },
];

export const initialLogs = [
  { id:'initial-1', time:'10:32:18', title:'演示数据已加载', detail:'已加载 6 类目录与 8 个大文件示例，未读取本机磁盘。', status:'success' },
  { id:'initial-2', time:'10:32:19', title:'保护规则已展示', detail:'系统目录、数据库和用户文件仅供查看，不进入演示清理候选。', status:'info' },
];

export function findDirectory(id, node = rootDirectory) {
  if (node.id === id) return node;
  for (const child of node.children) { const found = findDirectory(id, child); if (found) return found; }
  return null;
}

export function partition(items, x = 0, y = 0, width = 100, height = 100) {
  if (!items.length) return [];
  if (items.length === 1) return [{ ...items[0], x, y, width, height }];
  const total = items.reduce((s, i) => s + i.size, 0);
  let sum = 0, split = 1, distance = Infinity;
  for (let i = 0; i < items.length - 1; i++) {
    sum += items[i].size;
    if (Math.abs(total / 2 - sum) < distance) { distance = Math.abs(total / 2 - sum); split = i + 1; }
  }
  const ratio = items.slice(0, split).reduce((s, i) => s + i.size, 0) / total;
  if (width * 1.6 >= height) return [...partition(items.slice(0, split), x, y, width * ratio, height), ...partition(items.slice(split), x + width * ratio, y, width * (1 - ratio), height)];
  return [...partition(items.slice(0, split), x, y, width, height * ratio), ...partition(items.slice(split), x, y + height * ratio, width, height * (1 - ratio))];
}
