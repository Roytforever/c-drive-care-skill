"""Install an extracted Skill into an explicitly chosen, existing directory."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys

REPARSE = 0x400
REQUIRED = (
    'SKILL.md', 'manifest.json', 'install.py', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'runtime/run.py', 'runtime/doctor.py',
    'runtime/scripts/generate_report.py', 'runtime/server/scan-worker.py',
    'runtime/report-assets/template.html',
)


def no_reparse(path):
    current = Path(os.path.abspath(path))
    while True:
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & REPARSE:
            raise ValueError('路径或其上级是链接/重解析点: ' + str(current))
        if current.parent == current:
            return
        current = current.parent


def within(path, parent):
    path, parent = os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(parent))
    try:
        return os.path.commonpath((path, parent)) == parent
    except ValueError:
        return False


def manifest_for_existing(destination):
    try:
        no_reparse(destination)
        manifest = destination / 'manifest.json'
        no_reparse(manifest)
        if manifest.stat().st_size > 16384:
            return None
        result = json.loads(manifest.read_text(encoding='utf-8-sig'))
        return result.get('version') if isinstance(result, dict) and isinstance(result.get('version'), str) else None
    except (OSError, ValueError, UnicodeError):
        return None


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description='检查或安装解压后的 Skill；不修改其他技能或宿主配置')
    parser.add_argument('--target', required=True, help='宿主技能的现有父目录，本地绝对路径')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true', help='只读检查环境、目标和冲突')
    mode.add_argument('--dry-run', action='store_true', help='只读预览安装')
    mode.add_argument('--install', action='store_true', help='在空的目标位置安装')
    args = parser.parse_args(argv)
    source = Path(os.path.abspath(__file__)).parent
    created = None
    try:
        if not os.path.isabs(args.target) or args.target.startswith(('\\\\', '//')):
            raise ValueError('目标技能父目录必须是本地绝对路径；请按宿主实际安装方式指定')
        parent = Path(os.path.abspath(args.target))
        no_reparse(parent)
        if not parent.is_dir():
            raise ValueError('目标技能父目录不存在')
        if not os.access(parent, os.W_OK):
            raise ValueError('目标技能父目录不可写；请检查宿主权限')
        destination = parent / 'liubai-storage'
        if within(parent, source) or within(source, destination):
            raise ValueError('安装目标与技能包来源相互包含')
        if os.name != 'nt' or sys.version_info < (3, 10):
            raise ValueError('此技能需要 Windows 与 Python 3.10+；宿主是否允许本地工具需要另行确认')
        # Never follow a source symlink and never import extra files beside the manifest.
        contents = []
        for name in REQUIRED:
            path = source.joinpath(*name.split('/'))
            no_reparse(path)
            if not path.is_file():
                raise ValueError('技能包缺少必需文件: ' + name)
            contents.append((name, path.read_bytes()))
        manifest = json.loads(dict(contents)['manifest.json'].decode('utf-8-sig'))
        if (not isinstance(manifest, dict) or type(manifest.get('format')) is not int or manifest.get('format') != 1 or manifest.get('name') != 'liubai-storage'
                or not isinstance(manifest.get('version'), str)
                or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?', manifest['version'])):
            raise ValueError('技能包 manifest 无效')
        if dict(contents)['runtime/report-assets/template.html'].count(b'<!--LIUBAI_REPORT_DATA-->') != 1:
            raise ValueError('技能包网页模板无效')
        if os.path.lexists(destination):
            print(json.dumps({'status': 'conflict', 'target': str(destination),
                              'existingVersion': manifest_for_existing(destination),
                              'message': '目标技能已存在；不会覆盖，请先由用户决定如何处理。'}, ensure_ascii=False))
            return 1
        result = {'status': 'ready', 'version': manifest['version'], 'target': str(destination),
                  'files': [name for name, _ in contents], 'hostLocalTools': 'unknown',
                  'message': '宿主工具权限及目录 ACL 需在实际安装时验证；检查和预览不会写入文件。'}
        if not args.install:
            print(json.dumps(result, ensure_ascii=False))
            return 0
        # mkdir and exclusive file creation never overwrite existing user content.
        os.mkdir(destination)
        created = destination
        for name, content in contents:
            path = destination.joinpath(*name.split('/'))
            path.parent.mkdir(parents=True, exist_ok=True)
            no_reparse(path.parent)
            with path.open('xb') as stream:
                stream.write(content)
        result['status'] = 'installed'
        result['message'] = '仅安装技能文件；未修改宿主配置或安装依赖。请按宿主方式刷新并验证技能。'
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError) as error:
        result = {'status': 'error', 'message': str(error)}
        if created is not None:
            result['partialInstallation'] = str(created)
            result['message'] += '；部分新建文件保留，请检查后手动处理，未覆盖已有内容。'
        print(json.dumps(result, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
