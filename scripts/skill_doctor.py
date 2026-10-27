"""Inspect the installed Skill runtime without scanning or changing the disk."""
from __future__ import annotations

import json
import os
from pathlib import Path
import platform
import sys


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    root = Path(__file__).resolve().parent
    required = ('run.py', 'scripts/generate_report.py', 'scripts/cache_inventory.py', 'server/scan-worker.py',
                'report-assets/template.html')
    files = {name: (root / name).is_file() for name in required}
    template_valid = False
    if files['report-assets/template.html']:
        try:
            template = (root / 'report-assets/template.html').read_text(encoding='utf-8-sig')
            template_valid = template.count('<!--LIUBAI_REPORT_DATA-->') == 1
        except (OSError, UnicodeError):
            pass
    python_ok = sys.version_info >= (3, 10)
    windows = os.name == 'nt'
    result = {
        'version': 1,
        'platform': platform.system(),
        'pythonVersion': '.'.join(str(x) for x in sys.version_info[:3]),
        'python310OrNewer': python_ok,
        'windows': windows,
        'files': files,
        'templateValid': template_valid,
        'runtimeReady': windows and python_ok and all(files.values()) and template_valid,
        'hostLocalTools': 'unknown',
        'message': ('此检查不扫描磁盘、不安装依赖、不验证宿主是否授权本机访问。'
                    '缺少 Python 3.10+ 或 Windows 本地工具时，请先按宿主实际能力处理。'),
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['runtimeReady'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
