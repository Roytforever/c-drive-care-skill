"""Build a shareable Skill ZIP from an explicit, non-sensitive file list."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import zipfile

PROJECT = Path(os.path.abspath(__file__)).parents[1]
REPARSE = 0x400
ROOT = 'liubai-storage/'
FILES = {
    'skills/liubai-storage/SKILL.md': 'SKILL.md',
    'scripts/install_skill.py': 'install.py',
    'scripts/skill_manifest.json': 'manifest.json',
    'run.py': 'runtime/run.py',
    'scripts/skill_doctor.py': 'runtime/doctor.py',
    'scripts/generate_report.py': 'runtime/scripts/generate_report.py',
    'scripts/cache_inventory.py': 'runtime/scripts/cache_inventory.py',
    'server/scan-worker.py': 'runtime/server/scan-worker.py',
    'report-assets/template.html': 'runtime/report-assets/template.html',
    'LICENSE': 'LICENSE',
    'THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md',
}
LICENSE_FILES = ('LICENSE', 'THIRD_PARTY_NOTICES.md')


def no_reparse(path):
    """Fail closed when an existing path or ancestor is a link/mount point."""
    current = Path(os.path.abspath(path))
    while True:
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & REPARSE:
            raise ValueError('路径或其上级是链接/重解析点，拒绝打包: ' + str(current))
        if current.parent == current:
            break
        current = current.parent


def within(path, parent):
    path, parent = os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(parent))
    try:
        return os.path.commonpath((path, parent)) == parent
    except ValueError:
        return False


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description='从文件白名单构建可移植的只读 Skill ZIP')
    parser.add_argument('--output', required=True, help='新 ZIP 的本地绝对路径；父目录必须存在')
    args = parser.parse_args(argv)
    try:
        if not os.path.isabs(args.output) or args.output.startswith(('\\\\', '//')):
            raise ValueError('输出必须是本地绝对路径')
        output = Path(os.path.abspath(args.output))
        if output.suffix.casefold() != '.zip':
            raise ValueError('输出文件必须以 .zip 结尾')
        if within(output, PROJECT) and output.parent != PROJECT and not within(output, PROJECT / 'dist'):
            raise ValueError('项目内仅可写入项目根或 dist/；请勿写入私有数据或源码目录: ' + str(output))
        no_reparse(output.parent)
        if not output.parent.is_dir():
            raise ValueError('输出父目录不存在')
        # Load and validate every source before creating any output.
        contents = []
        for source, target in FILES.items():
            path = PROJECT / source
            no_reparse(path)
            if not path.is_file():
                raise ValueError('技能运行文件缺失: ' + source)
            data = path.read_bytes()
            if target.endswith('template.html') and data.count(b'<!--LIUBAI_REPORT_DATA-->') != 1:
                raise ValueError('技能模板数据标记无效，请重新构建模板')
            contents.append((ROOT + target, data))
        # Exclusive creation preserves any existing user file, including symlinks.
        with output.open('xb') as stream:
            with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                for target, content in contents:
                    # Avoid machine timestamps/permissions in releases so the same
                    # source tree produces the same artifact on the same runtime.
                    info = zipfile.ZipInfo(target, date_time=(1980, 1, 1, 0, 0, 0))
                    info.create_system = 3
                    info.external_attr = 0o100644 << 16
                    archive.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
        digest = hashlib.sha256(output.read_bytes()).hexdigest()
        print(json.dumps({'archive': str(output), 'files': [name for name, _ in contents],
                          'sha256': digest,
                          'licensesIncluded': list(LICENSE_FILES)},
                         ensure_ascii=False))
        return 0
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
