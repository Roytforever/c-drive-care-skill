#!/usr/bin/env node
import { createClient } from './client.mjs';

const commands = { report: 'liubai_report', status: 'liubai_status', caches: 'liubai_caches', files: 'liubai_files', scan: 'liubai_scan', cancel: 'liubai_cancel_scan', plan: 'liubai_plan' };
const usage = 'node integrations/cli.mjs report [--root C:\\] [--outDir report] [--overwrite true] [--measureAllocated true] | report --index index.json --reportOnly true | status | caches | files [--limit 25] [--offset 0] | scan --root C:\\ | cancel | plan --kind migrate --cacheId npm --driveId E:';

try {
  const [command, ...parts] = process.argv.slice(2);
  if (command === '--help' || command === 'help') {
    console.log(JSON.stringify({ usage, note: 'report 是默认静态报告入口，无需本地服务。其余六个旧版工具需要可选 HTTP 服务；本桥接不提供执行文件变更的工具。' }, null, 2));
  } else {
    const name = commands[command];
    if (!name) throw new Error(`不支持的命令。${usage}`);
    const input = {};
    for (let index = 0; index < parts.length; index += 2) {
      const flag = parts[index], value = parts[index + 1];
      if (!/^--[A-Za-z][A-Za-z0-9]*$/.test(flag) || value === undefined || Object.hasOwn(input, flag.slice(2))) throw new Error('参数必须成对提供，且不能重复，例如 --root "C:\\Users"');
      const key = flag.slice(2);
      if (key === 'reportOnly' || key === 'overwrite' || key === 'measureAllocated') {
        if (!['true','false'].includes(value)) throw new Error(`--${key} 必须为 true 或 false`);
        input[key] = value === 'true';
      } else input[key] = ['offset', 'limit'].includes(key) ? Number(value) : value;
    }
    const result = await createClient().callTool(name, input);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
