#!/usr/bin/env python3
"""Launch each scan or snapshot preview in its own report directory."""
import argparse
from datetime import datetime
import os
from pathlib import Path
import stat
import subprocess
import sys
from uuid import uuid4


PROJECT = Path(__file__).resolve().parents[1]
REPARSE_POINT = 0x400


def is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & REPARSE_POINT)


def reject_link_ancestors(path):
    """Do not read from or write through an existing link or junction."""
    path = Path(os.path.abspath(path))
    for component in (path, *path.parents):
        if os.path.lexists(component) and is_link(os.lstat(component)):
            raise ValueError(f'报告路径包含链接或重解析目录：{component}')


def latest_snapshot(report_dir):
    runs = report_dir / 'runs'
    reject_link_ancestors(runs)
    candidates = []

    def consider(index):
        try:
            info = os.lstat(index)
        except FileNotFoundError:
            return
        if not is_link(info) and stat.S_ISREG(info.st_mode):
            candidates.append((info.st_mtime_ns, str(index), index))

    consider(report_dir / 'index.json')
    if os.path.lexists(runs):
        if not stat.S_ISDIR(os.lstat(runs).st_mode):
            raise ValueError(f'报告运行目录不是文件夹：{runs}')
        with os.scandir(runs) as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                if not is_link(info) and stat.S_ISDIR(info.st_mode):
                    consider(Path(entry.path) / 'index.json')
    if not candidates:
        raise ValueError('没有可预览的扫描快照，请先生成一次报告。')
    return max(candidates)[2]


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description='安全地生成独立报告或从最近的快照重建报告')
    parser.add_argument('--root', default='C:\\', help='待扫描目录，默认 C:\\')
    parser.add_argument('--report-dir', type=Path, default=PROJECT / 'report', help='报告根目录')
    parser.add_argument('--preview', action='store_true', help='使用最近的已有快照，重新生成报告')
    parser.add_argument('--open', action='store_true', help='生成后打开报告')
    args = parser.parse_args()

    try:
        report_dir = Path(os.path.abspath(args.report_dir))
        reject_link_ancestors(report_dir / 'runs')
        snapshot = latest_snapshot(report_dir) if args.preview else None
        run_id = datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid4().hex
        output = report_dir / 'runs' / run_id
        reject_link_ancestors(output)
        command = [sys.executable, str(PROJECT / 'run.py')]
        if snapshot is not None:
            print(f'预览使用的快照：{snapshot}', file=sys.stderr, flush=True)
            command.extend(['--report-only', '--index', str(snapshot)])
        else:
            command.append(args.root)
        command.extend(['--out-dir', str(output)])
        if args.open:
            command.append('--open')
        print(f'报告输出目录：{output}', file=sys.stderr, flush=True)
        return subprocess.run(command, check=False).returncode
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
