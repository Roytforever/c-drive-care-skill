"""Metadata-only, fail-closed cache inventory. Never follows reparse points."""
import json, os, stat, sys

if os.name == 'nt':
    import ctypes
    from ctypes import wintypes
    class StreamData(ctypes.Structure):
        _fields_ = [('StreamSize', ctypes.c_longlong), ('cStreamName', ctypes.c_wchar * 296)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.FindFirstStreamW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(StreamData), wintypes.DWORD]
    kernel.FindFirstStreamW.restype = wintypes.HANDLE
    kernel.FindNextStreamW.argtypes = [wintypes.HANDLE, ctypes.POINTER(StreamData)]
    kernel.FindNextStreamW.restype = wintypes.BOOL
    kernel.FindClose.argtypes = [wintypes.HANDLE]

def check_streams(path):
    if os.name != 'nt':
        return
    data = StreamData()
    handle = kernel.FindFirstStreamW(path, 0, ctypes.byref(data), 0)
    if handle == ctypes.c_void_p(-1).value:
        error = ctypes.get_last_error()
        if error == 38:  # No streams on an ordinary directory.
            return
        raise ValueError('无法核验 Windows 数据流: ' + path)
    try:
        while True:
            if data.cStreamName != '::$DATA':
                raise ValueError('包含额外数据流，请通过所属工具处理: ' + path)
            if not kernel.FindNextStreamW(handle, ctypes.byref(data)):
                if ctypes.get_last_error() != 38:
                    raise ValueError('数据流核验失败: ' + path)
                break
    finally:
        kernel.FindClose(handle)

def checked(path):
    s = os.lstat(path)
    attrs = getattr(s, 'st_file_attributes', 0)
    if stat.S_ISLNK(s.st_mode) or attrs & 0x400:
        raise ValueError('路径包含链接或重解析点，已阻止操作: ' + path)
    if attrs & (0x1000 | 0x40000 | 0x400000):
        raise ValueError('路径包含离线或云占位文件，已阻止操作: ' + path)
    if attrs & 0x4000:
        raise ValueError('路径包含 EFS 加密文件，需人工处理: ' + path)
    return s

try:
    root = os.path.abspath(sys.argv[1])
    cursor = root
    while True:
        checked(cursor)
        parent = os.path.dirname(cursor)
        if parent == cursor:
            break
        cursor = parent
    if len(sys.argv) > 2 and sys.argv[2] == 'validate':
        print(json.dumps({'ok': True})); sys.exit(0)
    entries, total = [], 0
    stack = [root]
    while stack:
        current = stack.pop()
        s = checked(current)
        check_streams(current)
        is_dir = stat.S_ISDIR(s.st_mode)
        if not is_dir and not stat.S_ISREG(s.st_mode):
            raise ValueError('不支持的文件类型: ' + current)
        if not is_dir and s.st_nlink > 1:
            raise ValueError('缓存包含硬链接，需通过所属工具处理: ' + current)
        rel = os.path.relpath(current, root)
        entries.append({'rel': rel, 'directory': is_dir, 'size': 0 if is_dir else s.st_size,
                        'mtime': str(s.st_mtime_ns), 'ino': str(s.st_ino), 'dev': str(s.st_dev)})
        if len(entries) > 250000:
            raise ValueError('缓存超过 250000 项安全检查上限，请通过所属工具处理')
        if is_dir:
            with os.scandir(current) as children:
                stack.extend(c.path for c in children)
        else:
            total += s.st_size
    entries.sort(key=lambda e: e['rel'])
    print(json.dumps({'entries': entries, 'bytes': total, 'fileCount': sum(not e['directory'] for e in entries)}, ensure_ascii=True))
except Exception as error:
    print(json.dumps({'error': str(error)}, ensure_ascii=True)); sys.exit(1)
