import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./scan-worker.py', import.meta.url));
const emptyState = () => ({ id: null, status: 'idle', root: null, filesCount: 0, dirsCount: 0, totalBytes: 0,
  errors: 0, skipped: 0, errorDetails: [], skipDetails: [], startedAt: null, finishedAt: null,
  currentPath: '', directories: [], largeFiles: [], complete: false, truncated: false, displayPruned: false, displayOmittedDirectories: 0, warnings: [] });

export function createScanner({ onUpdate = () => {}, maxDirectories = 500000, maxDisplayDirectories = 20000, python = 'python' } = {}) {
  let state = emptyState();
  let child = null;
  let forceTimer = null;
  let cancellationRequested = false;
  const publish = patch => {
    state = { ...state, ...patch };
    try { onUpdate(state); } catch { /* UI persistence must not crash a scan worker. */ }
  };

  return {
    getState: () => state,
    async start(root) {
      if (child) throw new Error('已有扫描任务正在运行');
      if (typeof root !== 'string' || !path.isAbsolute(root) || root.length > 4096 || /[\0\r\n]/.test(root)) {
        throw new Error('请选择本地磁盘的绝对目录路径');
      }
      if (process.platform === 'win32' && (/^(?:\\\\|\/\/)/.test(root) || !/^[a-z]:[\\/]/i.test(root))) {
        throw new Error('第一版只支持本地盘符路径，不支持网络或设备路径');
      }
      cancellationRequested = false;
      state = { ...emptyState(), id: randomUUID(), status: 'running', root: path.resolve(root), startedAt: new Date().toISOString() };
      publish({});
      const task = spawn(python, ['-I', '-u', workerPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child = task;
      let buffer = '';
      let stderr = '';
      task.stdout.setEncoding('utf8');
      task.stderr.setEncoding('utf8');
      task.stdin.on('error', () => {});
      task.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      task.stdout.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const update = JSON.parse(line);
            if (cancellationRequested && update.status === 'completed') { update.status = 'cancelled'; update.complete = false; }
            publish(update);
          } catch { /* Partial lines are buffered; invalid worker output is handled at close. */ }
        }
      });
      task.on('error', error => {
        publish({ status: 'failed', error: `无法启动只读扫描器：${error.message}。需要 Python 3。`, complete: false, finishedAt: new Date().toISOString() });
      });
      task.on('close', code => {
        clearTimeout(forceTimer);
        child = null;
        if (state.status === 'running') {
          publish({ status: cancellationRequested ? 'cancelled' : 'failed', complete: false,
            error: cancellationRequested ? undefined : `扫描进程异常退出 (${code})：${stderr || '未返回完整结果'}`,
            finishedAt: new Date().toISOString() });
        }
      });
      task.stdin.write(JSON.stringify({ root: state.root, maxDirectories, maxDisplayDirectories }) + '\n');
      return state;
    },
    cancel() {
      if (!child || state.status !== 'running') return state;
      cancellationRequested = true;
      child.stdin.write('{"cancel":true}\n');
      clearTimeout(forceTimer);
      forceTimer = setTimeout(() => { child?.kill(); }, 3000);
      forceTimer.unref();
      return state;
    },
  };
}
