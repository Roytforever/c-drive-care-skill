"""Bounded, read-only cache configuration discovery; never executes a tool.

Only the requested path setting leaves this module. Credentials and unrelated
configuration are neither retained nor echoed. Parsed settings are evidence,
not confirmation of a running tool's effective configuration.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import stat

MAX_CONFIG_BYTES = 1024 * 1024
SPECIAL = 0x400 | 0x1000 | 0x40000 | 0x400000


def env_value(env, key, default=None):
    return next((v for k, v in env.items() if k.casefold() == key.casefold()), default)


def local_path(value):
    if not isinstance(value, str) or not value or any(c in value for c in '\x00\r\n'):
        return False
    if value.startswith(('\\\\', '//')) or re.search(r'\$\{|%[^%]+%', value):
        return False
    if not os.path.isabs(value):
        return False
    if os.name == 'nt':
        drive, rest = os.path.splitdrive(value)
        return len(drive) == 2 and drive[1] == ':' and ':' not in rest
    return True


def expand(value, env, home):
    value = re.sub(r'\$\{([^}]+)\}|%([^%]+)%',
                   lambda m: env_value(env, m.group(1) or m.group(2), m.group(0)), value)
    if value == '~' or value.startswith(('~/', '~\\')):
        value = str(home) + value[1:]
    return value


def checked_info(path):
    """Reject cloud placeholders, links and linked ancestors before reading."""
    path = Path(path)
    for ancestor in (*reversed(path.parents), path):
        info = os.lstat(ancestor)
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & SPECIAL:
            raise ValueError('路径含链接、重解析项或云占位')
    return info


def read_setting(path, wanted, section=None, syntax='ini'):
    """Extract a single literal key from INI, top-level TOML or simple YAML.

    This is intentionally not a general YAML/TOML interpreter: multiline,
    references, expressions and includes are rejected rather than evaluated.
    """
    result = {'value': None, 'uncertain': False, 'configPath': str(path)}
    if not local_path(str(path)):
        result['uncertain'] = True
        return result
    try:
        info = checked_info(path)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_CONFIG_BYTES:
            raise ValueError('配置文件类型或大小不受支持')
        flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
        with os.fdopen(os.open(path, flags), 'rb') as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_size > MAX_CONFIG_BYTES or not stat.S_ISREG(opened.st_mode)
                    or (info.st_ino and opened.st_ino and info.st_ino != opened.st_ino)):
                raise ValueError('配置文件在读取前发生变化')
            raw = stream.read(MAX_CONFIG_BYTES + 1)
        if len(raw) > MAX_CONFIG_BYTES:
            raise ValueError('配置文件过大')
        text = raw.decode('utf-8-sig')
        active = None
        for line in text.splitlines():
            trimmed = line.strip()
            if not trimmed or trimmed.startswith(('#', ';')):
                continue
            if trimmed.startswith('[') and trimmed.endswith(']'):
                active = trimmed[1:-1].casefold()
                continue
            if syntax == 'yaml':
                match = re.match(r'^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$', line)
            else:
                match = re.match(r'^([^=]+)=(.*)$', trimmed)
            if not match or match[1].strip().casefold() != wanted.casefold():
                continue
            if section is not None and active != section.casefold():
                continue
            if syntax == 'toml' and active is not None:
                continue
            value = match[2].strip()
            if syntax == 'toml':
                # Accept the normal literal/basic TOML string forms only.
                if len(value) < 2 or value[0] not in "'\"" or value[-1] != value[0]:
                    result['uncertain'] = True
                    continue
                try:
                    value = value[1:-1] if value[0] == "'" else json.loads(value)
                except (ValueError, TypeError):
                    result['uncertain'] = True
                    continue
            elif value[:1] in ("'", '"'):
                if len(value) < 2 or value[-1] != value[0]:
                    result['uncertain'] = True
                    continue
                # INI values commonly contain unescaped Windows backslashes.
                value = value[1:-1]
            elif syntax == 'yaml' and (not value or value[0] in '&*!>|{['):
                result['uncertain'] = True
                continue
            if isinstance(value, str):
                result['value'] = value
    except FileNotFoundError:
        pass
    except (OSError, UnicodeError, ValueError):
        result['uncertain'] = True
    return result


def _last_setting(paths, wanted, section=None, syntax='ini'):
    result = {'value': None, 'configPath': None, 'uncertain': False}
    for path in paths:
        item = read_setting(path, wanted, section, syntax)
        result['uncertain'] |= item['uncertain']
        if item['value'] is not None:
            result.update(value=item['value'], configPath=item['configPath'])
    return result


def _norm(path):
    return os.path.normcase(os.path.abspath(path))


def discover_caches(scan, *, env=None, home=None):
    """Discover known cache paths without scanning their contents or invoking tools."""
    env = os.environ if env is None else env
    home = Path.home() if home is None else Path(home)
    local = Path(env_value(env, 'LOCALAPPDATA', str(home / 'AppData' / 'Local')))
    roaming = Path(env_value(env, 'APPDATA', str(home / 'AppData' / 'Roaming')))
    program = Path(env_value(env, 'PROGRAMDATA', 'C:\\ProgramData' if os.name == 'nt' else '/etc'))
    npm_file = env_value(env, 'NPM_CONFIG_USERCONFIG', str(home / '.npmrc'))
    global_npm = env_value(env, 'NPM_CONFIG_GLOBALCONFIG')
    npm_paths = ([global_npm] if global_npm else []) + [npm_file]
    npm_setting = _last_setting(npm_paths, 'cache')
    pip_override = env_value(env, 'PIP_CONFIG_FILE')
    pip_paths = []
    if not pip_override or _norm(pip_override) != _norm(os.devnull):
        pip_paths.append(program / 'pip' / 'pip.ini')
        explicit_exists = False
        if pip_override and local_path(pip_override):
            try:
                explicit_exists = stat.S_ISREG(checked_info(pip_override).st_mode)
            except (OSError, ValueError):
                pass
        if not explicit_exists:
            pip_paths += [home / 'pip' / 'pip.ini', roaming / 'pip' / 'pip.ini']
        if env_value(env, 'VIRTUAL_ENV'):
            pip_paths.append(Path(env_value(env, 'VIRTUAL_ENV')) / 'pip.ini')
        if pip_override:
            pip_paths.append(pip_override)
    pip_setting = _last_setting(pip_paths, 'cache-dir', 'global')
    uv_setting = _last_setting([program / 'uv' / 'uv.toml', roaming / 'uv' / 'uv.toml'],
                               'cache-dir', syntax='toml')
    xdg = env_value(env, 'XDG_CONFIG_HOME')
    pnpm_yaml = (Path(xdg) / 'pnpm' / 'config.yaml') if xdg else local / 'pnpm' / 'config' / 'config.yaml'
    pnpm_setting = _last_setting([pnpm_yaml], 'storeDir', syntax='yaml')
    legacy_pnpm = False
    if pnpm_setting['value'] is None:
        legacy = _last_setting(npm_paths, 'store-dir')
        if legacy['value'] is not None:
            pnpm_setting = legacy
            legacy_pnpm = True
        else:
            pnpm_setting['uncertain'] |= legacy['uncertain']
    settings = {'npm': npm_setting, 'pip': pip_setting, 'uv': uv_setting, 'pnpm-store': pnpm_setting}
    definitions = [
        ('npm', 'npm 缓存', local / 'npm-cache', 'NPM_CONFIG_CACHE'),
        ('pip', 'pip 缓存', local / 'pip' / 'Cache', 'PIP_CACHE_DIR'),
        ('uv', 'uv 缓存', local / 'uv' / 'cache', 'UV_CACHE_DIR'),
        ('pnpm-store', 'pnpm store', local / 'pnpm' / 'store', 'PNPM_CONFIG_STORE_DIR'),
        ('gradle', 'Gradle 缓存', home / '.gradle' / 'caches', 'GRADLE_USER_HOME'),
        ('playwright', 'Playwright 浏览器', local / 'ms-playwright', 'PLAYWRIGHT_BROWSERS_PATH'),
        ('maven', 'Maven 本地仓库', home / '.m2' / 'repository', ''),
    ]
    nodes = {_norm(n['path']): n for n in scan.get('directories', [])}
    root = _norm(scan['root'])
    result = []
    for key, name, default, env_key in definitions:
        setting = settings.get(key, {})
        configured = env_value(env, env_key) if env_key else None
        raw = configured if configured is not None else setting.get('value')
        source = 'environment' if configured is not None else 'config' if raw is not None else 'default'
        location = expand(str(raw) if raw is not None else str(default), env, home)
        if key == 'gradle' and raw is not None:
            location = os.path.join(location, 'caches')
        valid = local_path(location)
        if valid:
            location = os.path.abspath(location)
        node = nodes.get(_norm(location)) if valid else None
        normalized = _norm(location) if valid else None
        in_scope = bool(valid and (normalized == root or normalized.startswith(root.rstrip(os.sep) + os.sep)))
        custom = not valid or normalized != _norm(default)
        coverage = dict(node['coverage']) if node and isinstance(node.get('coverage'), dict) else {'status': 'unknown' if node else 'unscanned', 'errors': None, 'skipped': None}
        exists = bool(node) if valid else None
        warnings = ['仅读取当前环境及已知全局/用户配置；项目、命令行、其他终端或工具版本仍可能覆盖，尚未核验实际生效路径。']
        if valid and not node:
            try:
                info = checked_info(location)
                exists = stat.S_ISDIR(info.st_mode)
            except FileNotFoundError:
                exists = False
            except (OSError, ValueError):
                exists = None
                warnings.append('目录无法安全核验，可能为链接、云占位或权限受限；未遍历。')
        if not valid:
            warnings.append('配置不是受支持的本地绝对路径，未访问该位置。')
        if setting.get('uncertain'):
            warnings.append('部分配置无法安全读取或不属于支持的简单格式，来源可能不完整。')
        if custom:
            warnings.append('自定义目录可能混有用户数据，仅供调查，不能作为通用缓存迁移或删除。')
        if not in_scope:
            warnings.append('该位置不在本次扫描范围内，未计入本次大小。')
        if key == 'maven':
            warnings.append('可能含未发布私有构件，不能作为通用可重建缓存删除。')
        if key == 'pnpm-store' and legacy_pnpm and source == 'config':
            warnings.append('store-dir 来自旧版 .npmrc 规则；新版 pnpm 使用 config.yaml，需按实际版本核验。')
        result.append({'id': key, 'name': name, 'path': location, 'defaultPath': str(default),
                       'envKey': env_key, 'bytes': node['bytes'] if node else None,
                       'exists': exists, 'supported': False, 'source': source,
                       'configPath': setting.get('configPath') if source == 'config' else None,
                       'evidenceStatus': ('unverified' if not valid or setting.get('uncertain') else 'default' if source == 'default' else 'configured'),
                       'protected': custom or key in ('gradle', 'maven') or not valid,
                       'inScanScope': in_scope, 'coverage': coverage,
                       'sizeIsPartial': coverage.get('status') != 'complete', 'warnings': warnings})
    return result
