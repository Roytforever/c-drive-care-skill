"""Provider-neutral disk scan and static report renderer (Python standard library)."""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import gzip
import math
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import webbrowser

if __package__:
    from .cache_inventory import discover_caches
else:
    # Support direct script/runpy execution without searching the working
    # directory or relying on a host-specific import path.
    import importlib.util
    _inventory_spec = importlib.util.spec_from_file_location(
        '_liubai_cache_inventory', Path(__file__).resolve().with_name('cache_inventory.py'))
    _inventory_module = importlib.util.module_from_spec(_inventory_spec)
    _inventory_spec.loader.exec_module(_inventory_module)
    discover_caches = _inventory_module.discover_caches

PROJECT = Path(__file__).resolve().parents[1]
DATA_MARKER = '<!--LIUBAI_REPORT_DATA-->'
PRIVATE_KEYS = {'csrftoken', 'confirmationtext', 'snapshot', 'previousconfig', 'authorization',
                'apikey', 'password', 'secret', 'credentials', 'token', 'plans'}
FINAL_STATUSES = {'completed', 'cancelled', 'failed', 'interrupted'}


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sanitize(value):
    """Strip transport/execution credentials; paths remain display-only report data."""
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()
                if ''.join(c for c in key.casefold() if c.isalnum()) not in PRIVATE_KEYS}
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    return value


def safe_json(value):
    # JSON-in-HTML must not contain any raw closing tag or JS line separator.
    return escape_json(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False))


def escape_json(serialized):
    return (serialized.replace('&', '\\u0026').replace('<', '\\u003c').replace('>', '\\u003e')
            .replace('\u2028', '\\u2028').replace('\u2029', '\\u2029'))


def validate_issue_summary(scan):
    """A new summary must account for every issue; older snapshots lack it entirely."""
    if 'issueSummary' not in scan:
        return
    summary = scan['issueSummary']
    if not isinstance(summary, dict) or type(summary.get('version')) is not int or summary['version'] != 1:
        raise ValueError('扫描问题汇总版本无效')
    for key in ('errors', 'skipped'):
        group = summary.get(key)
        if not isinstance(group, dict) or not isinstance(group.get('reasonCounts'), list) or not isinstance(group.get('directories'), list):
            raise ValueError('扫描问题汇总格式无效: ' + key)
        reasons = group['reasonCounts']
        directories = group['directories']
        other = group.get('otherDirectoryEvents')
        valid_count = lambda count: type(count) is int and count >= 0
        if not valid_count(other):
            raise ValueError('扫描问题汇总遗漏目录计数无效: ' + key)
        codes = set()
        for item in reasons:
            if (not isinstance(item, dict) or not isinstance(item.get('code'), str) or not item['code']
                    or not isinstance(item.get('label'), str) or not item['label']
                    or not valid_count(item.get('count')) or item['count'] == 0 or item['code'] in codes):
                raise ValueError('扫描问题原因汇总无效: ' + key)
            codes.add(item['code'])
        for item in directories:
            if (not isinstance(item, dict) or not isinstance(item.get('path'), str) or not item['path']
                    or not valid_count(item.get('count')) or item['count'] == 0):
                raise ValueError('扫描问题目录汇总无效: ' + key)
        total = scan.get(key, 0)
        if sum(item['count'] for item in reasons) != total or sum(item['count'] for item in directories) + other != total:
            raise ValueError('扫描问题汇总与统计数量不一致: ' + key)


def compact_issue_summary(scan):
    """Keep model-facing output bounded; full directory paths remain in the local report."""
    summary = scan.get('issueSummary')
    if summary is None:
        return None
    result = {'version': summary['version']}
    for key in ('errors', 'skipped'):
        group = summary[key]
        result[key] = {'reasonCounts': group['reasonCounts'], 'recordedDirectories': len(group['directories']),
                       'otherDirectoryEvents': group['otherDirectoryEvents']}
    return result


def validate_scan(scan):
    if not isinstance(scan, dict) or scan.get('status') not in FINAL_STATUSES:
        raise ValueError('扫描快照必须已结束；进行中或未知格式不能作为完成报告')
    if not isinstance(scan.get('root'), str) or not scan['root']:
        raise ValueError('扫描快照缺少根路径')
    if not isinstance(scan.get('directories'), list) or not isinstance(scan.get('largeFiles'), list):
        raise ValueError('扫描快照缺少目录或大文件索引')
    for key in ('totalBytes', 'filesCount', 'dirsCount', 'errors', 'skipped'):
        value = scan.get(key, 0)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError('扫描快照统计字段无效: ' + key)
    validate_issue_summary(scan)
    ids = set()
    for node in scan['directories']:
        if not isinstance(node, dict) or not isinstance(node.get('id'), str) or node['id'] in ids:
            raise ValueError('扫描快照目录标识缺失或重复')
        ids.add(node['id'])
        if not isinstance(node.get('path'), str) or not node['path']:
            raise ValueError('扫描快照目录路径无效')
        for key in ('bytes', 'ownBytes', 'omittedBytes'):
            value = node.get(key, 0)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError('扫描快照目录体积无效')
        for key in ('ownFileCount', 'fileDetailsCount', 'directErrors', 'directSkipped'):
            if key in node and (type(node[key]) is not int or node[key] < 0):
                raise ValueError('扫描快照目录计数无效: ' + key)
        if 'coverage' in node:
            coverage = node['coverage']
            if (not isinstance(coverage, dict) or coverage.get('status') not in ('complete', 'partial', 'unscanned')
                    or any(type(coverage.get(k)) is not int or coverage[k] < 0 for k in ('errors', 'skipped'))):
                raise ValueError('扫描快照目录覆盖状态无效')
    if scan['directories']:
        by_id = {node['id']: node for node in scan['directories']}
        if sum(node.get('parentId') is None for node in scan['directories']) != 1:
            raise ValueError('扫描快照目录树必须有唯一根目录')
        checked = set()
        for node in scan['directories']:
            cursor = node
            trail = set()
            while cursor['id'] not in checked:
                if cursor['id'] in trail:
                    raise ValueError('扫描快照目录关系存在循环')
                trail.add(cursor['id'])
                parent_id = cursor.get('parentId')
                if parent_id is None:
                    break
                if parent_id not in by_id:
                    raise ValueError('扫描快照缺少父目录，无法安全下钻')
                cursor = by_id[parent_id]
            checked.update(trail)
    elif scan['status'] == 'completed':
        raise ValueError('已完成的扫描快照缺少根目录索引')
    for item in scan['largeFiles']:
        if not isinstance(item, dict) or not isinstance(item.get('path'), str):
            raise ValueError('扫描快照文件路径无效')
        value = item.get('bytes')
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError('扫描快照文件体积无效')
    if 'fileDetails' in scan:
        details = scan['fileDetails']
        if not isinstance(details, list) or len(details) > 100000:
            raise ValueError('扫描快照文件明细格式或数量无效')
        by_id = {node['id']: node for node in scan['directories']}
        counts = {}
        paths = set()
        normalize = lambda path: path.replace('\\', '/').rstrip('/').casefold()
        for item in details:
            if not isinstance(item, dict) or not isinstance(item.get('path'), str) or not item['path']:
                raise ValueError('扫描快照文件明细路径无效')
            parent = item.get('parentId')
            if not isinstance(parent, str) or parent not in by_id:
                raise ValueError('扫描快照文件明细缺少父目录')
            path = normalize(item['path'])
            if '/' not in path or path.rsplit('/', 1)[0] != normalize(by_id[parent]['path']) or path in paths:
                raise ValueError('扫描快照文件明细位置与父目录不一致或重复')
            value = item.get('bytes')
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError('扫描快照文件明细体积无效')
            paths.add(path)
            counts[parent] = counts.get(parent, 0) + 1
        for node in scan['directories']:
            if 'fileDetailsCount' in node and node['fileDetailsCount'] != counts.get(node['id'], 0):
                raise ValueError('扫描快照目录文件明细数量不一致')
            if 'ownFileCount' in node and node['ownFileCount'] < counts.get(node['id'], 0):
                raise ValueError('扫描快照文件明细多于目录文件数量')
        if 'fileDetailPolicy' in scan:
            policy = scan['fileDetailPolicy']
            keys = ('maxPerDirectory', 'maxTotal', 'retained', 'omitted')
            if (not isinstance(policy, dict) or any(type(policy.get(k)) is not int or policy[k] < 0 for k in keys)
                    or policy['retained'] != len(details) or policy['retained'] > policy['maxTotal']):
                raise ValueError('扫描快照文件明细策略无效')


def normalize_snapshot(payload, source_mode='snapshot'):
    if not isinstance(payload, dict):
        raise ValueError('索引应为 JSON 对象')
    scan = payload.get('scan') if 'scan' in payload else payload
    validate_scan(scan)
    # sanitize already creates each dictionary/list once; a preceding deepcopy
    # doubled peak memory without adding isolation for JSON snapshots.
    full = sanitize(payload if 'scan' in payload else {'scan': scan})
    full['version'] = '2.0-static'
    full['generatedAt'] = utc_now()
    full['sourceMode'] = source_mode
    for field in ('drives', 'caches', 'history', 'operations'):
        if field not in full:
            full[field] = []
        if not isinstance(full[field], list):
            raise ValueError('索引字段应为列表: ' + field)
    report = full.setdefault('report', {})
    if not isinstance(report, dict):
        raise ValueError('报告元信息无效')
    warnings = report.setdefault('inventoryWarnings', [])
    if not isinstance(warnings, list):
        raise ValueError('报告警告应为列表')
    if source_mode == 'snapshot':
        report['sourceDescription'] = '由已有扫描快照重新生成；生成时间不代表重新扫描时间。'
        if not full['drives']:
            warnings.append('原快照没有卷容量信息；保持未知，不读取当前磁盘容量冒充快照时数据。')
        if not full['caches']:
            warnings.append('原快照没有工具配置清单；缓存建议仅依据快照中的路径线索，生效配置需另行核验。')
    return full


def read_template(template_path):
    try:
        document = template_path.read_text(encoding='utf-8-sig')
    except OSError as error:
        raise ValueError('静态报告模板无法读取；请先由开发者执行 npm run build:report: ' + str(template_path)) from error
    if document.count(DATA_MARKER) != 1:
        raise ValueError('静态报告模板必须含有唯一数据标记')
    if '<!--LIUBAI_REPORT_BUILD-->' in document:
        raise ValueError('静态报告模板尚未完成构建')
    return document


def render_report(template, state, compress=True, *, serialized=None):
    serialized = safe_json(state) if serialized is None else escape_json(serialized)
    raw = serialized.encode('utf-8')
    if compress and len(raw) > 1024 * 1024:
        encoded = base64.b64encode(gzip.compress(raw, compresslevel=6, mtime=0)).decode('ascii')
        data = '<script id="liubai-report-data" type="application/octet-stream" data-encoding="gzip-base64">' + encoded + '</script>'
    else:
        data = '<script id="liubai-report-data" type="application/json" data-encoding="json">' + serialized + '</script>'
    return template.replace(DATA_MARKER, data)


def atomic_write(destination, content, *, overwrite=False):
    """Create a new artifact exclusively, or replace it only when explicitly allowed."""
    destination = Path(destination)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + destination.name + '-', suffix='.tmp', dir=destination.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if overwrite:
            os.replace(temporary, destination)
        else:
            try:
                # A hard-link publish is atomic and fails if another process has
                # created a destination after the initial conflict check.
                os.link(temporary, destination)
            except FileExistsError:
                raise FileExistsError('输出已存在，拒绝覆盖: ' + str(destination)) from None
            except OSError:
                # Some filesystems do not support hard links. Exclusive create is
                # still safe against overwriting an existing destination, though
                # a write failure may leave a newly created partial file.
                try:
                    with destination.open('x', encoding='utf-8', newline='\n') as stream:
                        stream.write(content)
                        stream.flush()
                        os.fsync(stream.fileno())
                except FileExistsError:
                    raise FileExistsError('输出已存在，拒绝覆盖: ' + str(destination)) from None
                except OSError as error:
                    raise OSError('输出创建失败，可能保留新建的不完整文件: ' + str(destination)) from error
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def env_value(key, default=None):
    return next((value for name, value in os.environ.items() if name.casefold() == key.casefold()), default)


def inventory(scan):
    """Collect read-only current metadata only for a new scan, never while re-rendering old input."""
    warnings = []
    drives = []
    if os.name == 'nt':
        script = ("[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"
                  "@([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -eq [System.IO.DriveType]::Fixed } | ForEach-Object {"
                  "[pscustomobject]@{id=$_.Name.Substring(0,2);label=$_.VolumeLabel;path=$_.Name;totalBytes=$_.TotalSize;freeBytes=$_.AvailableFreeSpace;"
                  "isSystem=($_.Name.Substring(0,2) -eq $env:SystemDrive)}}) | ConvertTo-Json -Compress")
        try:
            result = subprocess.run(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
                                    capture_output=True, encoding='utf-8', timeout=20, check=True,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            drives = json.loads(result.stdout.lstrip('\ufeff') or '[]')
            drives = drives if isinstance(drives, list) else [drives]
            for drive in drives:
                drive['label'] = drive.get('label') or '本地磁盘 (' + drive['id'] + ')'
        except (OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
            warnings.append('无法读取卷容量；保留未知值: ' + str(error)[:200])
    else:
        try:
            stats = os.statvfs(scan['root'])
            drives = [{'id': '/', 'path': '/', 'label': '本地文件系统', 'isSystem': True,
                       'totalBytes': stats.f_blocks * stats.f_frsize, 'freeBytes': stats.f_bavail * stats.f_frsize}]
        except (OSError, AttributeError) as error:
            warnings.append('无法读取卷容量；保留未知值: ' + str(error)[:200])
    caches = discover_caches(scan)
    return {'drives': drives, 'caches': caches, 'report': {'inventoryWarnings': warnings}}


def scan_directory(root, max_directories=500000, max_display_directories=500000, *, measure_allocated=False):
    root = os.path.abspath(root)
    worker = PROJECT / 'server' / 'scan-worker.py'
    process = subprocess.Popen([sys.executable, '-I', '-u', str(worker)], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8',
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    last = None
    try:
        process.stdin.write(json.dumps({'root': root, 'maxDirectories': max_directories,
                                       'maxDisplayDirectories': max_display_directories,
                                       'measureAllocated': measure_allocated}) + '\n')
        process.stdin.flush()
        for line in process.stdout:
            update = json.loads(line)
            last = update
            if update['status'] == 'running':
                print(f"只读扫描：{update['filesCount']:,} 文件 / {update['dirsCount']:,} 目录 / {update['totalBytes']:,} 字节", file=sys.stderr, flush=True)
        process.wait(timeout=15)
        if process.returncode != 0 or last is None:
            raise ValueError('只读扫描器异常退出: ' + process.stderr.read()[-1200:])
        validate_scan(last)
        return last
    except KeyboardInterrupt:
        process.stdin.write('{"cancel":true}\n')
        process.stdin.flush()
        try:
            output, _ = process.communicate(timeout=5)
            for line in output.splitlines():
                last = json.loads(line)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
        if last is None:
            raise ValueError('扫描已取消，没有可保留的索引')
        last['status'] = 'cancelled'
        last['complete'] = False
        validate_scan(last)
        return last
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description='只读扫描 Windows 磁盘并生成可离线打开的单文件 HTML 报告')
    parser.add_argument('volume', nargs='?', default='C:\\', help='待扫描的本地目录，默认 C:\\')
    parser.add_argument('--out-dir', default='report', help='产物目录，默认 ./report')
    parser.add_argument('--report-only', action='store_true', help='只重建已有快照，不扫描或读取当前卷容量')
    parser.add_argument('--index', help='--report-only 使用的已有 JSON 索引')
    parser.add_argument('--template', type=Path, default=PROJECT / 'report-assets' / 'template.html', help='预构建的单文件报告模板')
    parser.add_argument('--max-directories', type=int, default=500000, help='扫描目录上限，1–500000')
    parser.add_argument('--max-display-directories', type=int, default=500000, help='报告保留的目录数量，1–500000')
    parser.add_argument('--measure-allocated', action='store_true', help='额外只读测量分配空间与硬链接身份；更慢，不代表可释放量')
    parser.add_argument('--open', action='store_true', help='生成后用系统默认浏览器打开本地 HTML')
    parser.add_argument('--no-compress', action='store_true', help='不压缩内嵌数据，供不支持浏览器内置 gzip 解压的旧浏览器使用')
    parser.add_argument('--overwrite', action='store_true', help='允许替换已有输出；已有输入索引仍保留')
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.max_directories <= 500000 or not 1 <= args.max_display_directories <= 500000:
            raise ValueError('目录上限必须在 1–500000 之间')
        if args.report_only and args.measure_allocated:
            raise ValueError('--measure-allocated 仅用于新扫描，不能对旧快照冒充当前测量')
        if args.report_only and not args.index:
            raise ValueError('--report-only 必须提供 --index')
        if not args.report_only and args.index:
            raise ValueError('--index 仅与 --report-only 同时使用，避免覆盖或混淆输入')
        source = Path(args.index).resolve() if args.report_only else None
        output = Path(args.out_dir).resolve()
        if os.path.lexists(output) and not output.is_dir():
            raise ValueError('输出路径不是目录: ' + str(output))
        report_path, index_path = output / 'report.html', output / 'index.json'
        source_is_index = source is not None and source == index_path.resolve()
        if source is not None and source == report_path.resolve():
            raise ValueError('输入索引与输出报告是同一文件，拒绝覆盖输入')
        for path in (report_path, index_path):
            if path.is_dir():
                raise ValueError('输出已存在且是目录，不能作为报告文件: ' + str(path))
        if not args.overwrite:
            conflicts = [path for path in (report_path, index_path)
                         if not (path == index_path and source_is_index) and os.path.lexists(path)]
            if conflicts:
                raise ValueError('输出已存在，拒绝覆盖：' + '、'.join(map(str, conflicts)) + '；请更换输出目录或明确使用 --overwrite。')
        template = read_template(args.template)
        if args.report_only:
            state = normalize_snapshot(json.loads(source.read_text(encoding='utf-8-sig')))
        else:
            if not os.path.isabs(args.volume):
                raise ValueError('请提供待扫描目录的本地绝对路径')
            scan = scan_directory(args.volume, args.max_directories, args.max_display_directories,
                                  measure_allocated=args.measure_allocated)
            state = normalize_snapshot({'scan': scan, **inventory(scan)}, source_mode='scan')
        serialized = json.dumps(state, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        document = render_report(template, state, compress=not args.no_compress, serialized=serialized)
        output.mkdir(parents=True, exist_ok=True)
        published = []
        try:
            if not source_is_index:
                atomic_write(index_path, serialized,
                             overwrite=args.overwrite)
                published.append(index_path)
            atomic_write(report_path, document, overwrite=args.overwrite)
            published.append(report_path)
        except OSError as error:
            if published:
                raise OSError(str(error) + '；已写入的产物：' + '、'.join(map(str, published)) + '，请检查。') from error
            raise
        result = {'report': str(report_path), 'index': str(index_path), 'status': state['scan']['status'],
                  'sourceMode': state['sourceMode'], 'scanFinishedAt': state['scan'].get('finishedAt'),
                  'filesCount': state['scan'].get('filesCount', 0), 'dirsCount': state['scan'].get('dirsCount', 0),
                  'errors': state['scan'].get('errors', 0), 'skipped': state['scan'].get('skipped', 0),
                  'complete': state['scan'].get('complete'), 'truncated': state['scan'].get('truncated'),
                  'measurement': state['scan'].get('measurement'),
                  'issueSummary': compact_issue_summary(state['scan'])}
        print(json.dumps(result, ensure_ascii=False))
        if args.open:
            webbrowser.open(report_path.as_uri())
        return 0 if state['scan']['status'] == 'completed' else 2
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
