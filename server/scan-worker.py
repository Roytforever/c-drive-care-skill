"""Read-only metadata scanner. JSON-lines over stdin/stdout; never opens file content."""
import datetime
import errno
import heapq
import json
import os
import stat
import sys
import threading
import time

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
REPARSE = 0x400
OFFLINE = 0x1000 | 0x40000 | 0x400000
SYMLINK_TAG = 0xA000000C
MOUNT_POINT_TAG = 0xA0000003
cancelled = threading.Event()


def emit(data):
    print(json.dumps(data, ensure_ascii=False, separators=(",", ":")), flush=True)


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def filesystem_path(path):
    """Use extended local paths for Windows I/O; keep report paths unchanged."""
    return "\\\\?\\" + path if os.name == "nt" else path


class IssueSummary:
    """Count every event while bounding the number of retained directory names."""
    def __init__(self, directory_limit=2000):
        self.directory_limit = directory_limit
        self.groups = {key: {"reasons": {}, "directories": {}, "otherDirectoryEvents": 0}
                       for key in ("errors", "skipped")}

    def add(self, kind, code, label, directory):
        group = self.groups[kind]
        reason = group["reasons"].setdefault(code, {"code": code, "label": label, "count": 0})
        reason["count"] += 1
        key = os.path.normcase(directory)
        if key in group["directories"]:
            group["directories"][key]["count"] += 1
        elif len(group["directories"]) < self.directory_limit:
            group["directories"][key] = {"path": directory, "count": 1}
        else:
            group["otherDirectoryEvents"] += 1

    def finalize(self):
        result = {"version": 1}
        for kind, group in self.groups.items():
            result[kind] = {
                "reasonCounts": sorted(group["reasons"].values(), key=lambda item: (-item["count"], item["code"])),
                "directories": sorted(group["directories"].values(), key=lambda item: (-item["count"], item["path"])),
                "otherDirectoryEvents": group["otherDirectoryEvents"],
            }
        return result


def error_category(error):
    windows_code = getattr(error, "winerror", None)
    if windows_code is not None:
        labels = {3: "找不到路径或路径过长", 5: "访问被拒绝"}
        return "winerror:" + str(windows_code), labels.get(windows_code, "Windows 错误 " + str(windows_code))
    error_number = getattr(error, "errno", None)
    if error_number is not None:
        labels = {errno.EACCES: "访问被拒绝", errno.ENOENT: "路径不存在", errno.EPERM: "操作被拒绝"}
        return "errno:" + str(error_number), labels.get(error_number, "系统错误 " + str(error_number))
    return "other", "其他读取错误"


def reparse_category(info):
    tag = getattr(info, "st_reparse_tag", 0)
    if tag == SYMLINK_TAG or (not tag and stat.S_ISLNK(info.st_mode)):
        return "reparse:symlink", "符号链接"
    if tag == MOUNT_POINT_TAG:
        return "reparse:junction", "目录联接或挂载点"
    return "reparse:other", "其他重解析项"


def kind_for(filename):
    ext = os.path.splitext(filename)[1].lower()
    if ext in {".vhd", ".vhdx", ".vmdk", ".qcow2"}:
        return "虚拟磁盘", True
    if ext in {".db", ".sqlite", ".sqlite3", ".mdf", ".ldf", ".ibd", ".mdb"}:
        return "数据库", True
    if ext in {".sys", ".dll", ".dat", ".reg"}:
        return "系统或应用数据", True
    if ext in {".iso", ".img"}:
        return "镜像文件", True
    if ext in {".zip", ".7z", ".rar", ".tar", ".gz"}:
        return "压缩文件", True
    if ext in {".exe", ".msi", ".msix"}:
        return "程序或安装介质", True
    if ext in {".safetensors", ".gguf", ".pt", ".onnx"}:
        return "模型文件", True
    return "用户或应用文件", True


def validate_root(root):
    if os.name == "nt" and (root.startswith(("\\\\", "//")) or len(os.path.splitdrive(root)[0]) != 2):
        raise ValueError("Only local drive paths can be scanned")
    if not os.path.isabs(root):
        raise ValueError("Scan root must be an absolute path")
    normalized = os.path.abspath(root)
    ancestor = normalized
    while True:
        info = os.lstat(filesystem_path(ancestor))
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE:
            raise ValueError("Scan root or ancestor is a reparse / symbolic link")
        if getattr(info, "st_file_attributes", 0) & OFFLINE:
            raise ValueError("Scan root or ancestor is an offline placeholder")
        parent = os.path.dirname(ancestor)
        if parent == ancestor:
            break
        ancestor = parent
    if not os.path.isdir(filesystem_path(normalized)):
        raise ValueError("Scan root is not a directory")
    return normalized



class AllocationReader:
    """Optional, metadata-only measurement. No elevation or following links."""
    def __init__(self):
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes
        self.ctypes = ctypes
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        class HandleInfo(ctypes.Structure):
            _fields_ = [("attributes", wintypes.DWORD), ("created", wintypes.FILETIME),
                        ("accessed", wintypes.FILETIME), ("modified", wintypes.FILETIME),
                        ("volume", wintypes.DWORD), ("sizeHigh", wintypes.DWORD), ("sizeLow", wintypes.DWORD),
                        ("links", wintypes.DWORD), ("idHigh", wintypes.DWORD), ("idLow", wintypes.DWORD)]
        class StandardInfo(ctypes.Structure):
            _fields_ = [("allocationSize", ctypes.c_longlong), ("endOfFile", ctypes.c_longlong),
                        ("links", wintypes.DWORD), ("deletePending", ctypes.c_ubyte), ("directory", ctypes.c_ubyte)]
        class CompressionInfo(ctypes.Structure):
            _fields_ = [("compressedSize", ctypes.c_longlong), ("format", wintypes.WORD),
                        ("unitShift", ctypes.c_ubyte), ("chunkShift", ctypes.c_ubyte),
                        ("clusterShift", ctypes.c_ubyte), ("reserved", ctypes.c_ubyte * 3)]
        class FileIdInfo(ctypes.Structure):
            _fields_ = [("volume", ctypes.c_ulonglong), ("identifier", ctypes.c_ubyte * 16)]
        self.HandleInfo, self.StandardInfo, self.CompressionInfo = HandleInfo, StandardInfo, CompressionInfo
        self.FileIdInfo = FileIdInfo
        self.kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                           wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        self.kernel.CreateFileW.restype = wintypes.HANDLE
        self.kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(HandleInfo)]
        self.kernel.GetFileInformationByHandle.restype = wintypes.BOOL
        self.kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL

    def measure(self, path, expected_size):
        if os.name != "nt":
            info = os.stat(filesystem_path(path), follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_size != expected_size:
                raise ValueError("File changed during allocation measurement")
            if not info.st_ino or not hasattr(info, "st_blocks"):
                raise ValueError("Stable file identity or allocated-block information unavailable")
            return (info.st_dev, info.st_ino), info.st_blocks * 512
        ctypes, kernel = self.ctypes, self.kernel
        # FILE_READ_ATTRIBUTES, shared read/write/delete, OPEN_EXISTING,
        # FILE_FLAG_OPEN_REPARSE_POINT. A metadata handle never reads file content.
        handle = kernel.CreateFileW(filesystem_path(path), 0x80, 7, None, 3, 0x00200000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            info = self.HandleInfo()
            if not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
                raise ctypes.WinError(ctypes.get_last_error())
            if info.attributes & (REPARSE | OFFLINE | 0x10):
                raise ValueError("Allocation target became a reparse, offline, or non-file entry")
            size = (info.sizeHigh << 32) | info.sizeLow
            file_id = self.FileIdInfo()
            if not kernel.GetFileInformationByHandleEx(handle, 18, ctypes.byref(file_id), ctypes.sizeof(file_id)):
                raise ctypes.WinError(ctypes.get_last_error())
            # FileIdInfo retains the full 128-bit identity on filesystems such as ReFS.
            identity = (file_id.volume, bytes(file_id.identifier))
            if size != expected_size or not any(file_id.identifier):
                raise ValueError("File changed or stable file identity unavailable")
            standard = self.StandardInfo()
            if not kernel.GetFileInformationByHandleEx(handle, 1, ctypes.byref(standard), ctypes.sizeof(standard)):
                raise ctypes.WinError(ctypes.get_last_error())
            allocated = standard.allocationSize
            if info.attributes & (0x800 | 0x200):  # compressed or sparse
                compression = self.CompressionInfo()
                if not kernel.GetFileInformationByHandleEx(handle, 8, ctypes.byref(compression), ctypes.sizeof(compression)):
                    raise ctypes.WinError(ctypes.get_last_error())
                allocated = compression.compressedSize
            if allocated < 0:
                raise ValueError("Invalid allocated byte count")
            return identity, allocated
        finally:
            kernel.CloseHandle(handle)


def main():
    config = json.loads(sys.stdin.readline())
    max_dirs = max(1, min(int(config.get("maxDirectories", 500000)), 500000))
    max_display_dirs = max(1, min(int(config.get("maxDisplayDirectories", 20000)), 500000))
    max_files = 500
    measure_allocated = config.get("measureAllocated") is True
    max_allocation_files = max(1, min(int(config.get("maxAllocationFiles", 500000)), 3000000))
    max_per_directory = max(1, min(int(config.get("maxFilesPerDirectory", 20)), 100))
    max_file_details = max(1, min(int(config.get("maxFileDetails", 100000)), 100000))
    max_entries = 3000000
    max_seconds = 1800
    state = {"status": "running", "root": config["root"], "filesCount": 0, "dirsCount": 0,
             "totalBytes": 0, "errors": 0, "skipped": 0, "errorDetails": [], "skipDetails": [],
             "startedAt": utc(), "finishedAt": None, "currentPath": config["root"],
             "complete": False, "truncated": False, "displayPruned": False, "displayOmittedDirectories": 0,
             "warnings": [], "directories": [], "largeFiles": [], "fileDetails": [],
             "limits": {"maxDirectories": max_dirs, "maxLargeFiles": max_files, "maxEntries": max_entries,
                        "maxSeconds": max_seconds, "maxDisplayDirectories": max_display_dirs,
                        "maxFileDetails": max_file_details, "maxFilesPerDirectory": max_per_directory}, "measurement": "logical-bytes"}
    allocation = {"requested": measure_allocated, "status": "not-measured", "allocatedBytes": None,
                  "deduplicatedLogicalBytes": None, "knownAllocatedBytes": 0, "knownDeduplicatedLogicalBytes": 0,
                  "measuredFiles": 0, "uniqueFiles": 0, "duplicatePaths": 0, "errors": 0, "omittedFiles": 0,
                  "scope": "scan-root", "attribution": "first-seen-path", "maxFiles": max_allocation_files}
    state["allocation"] = allocation
    allocation_reader = AllocationReader() if measure_allocated else None
    identities = set()
    nodes = []
    largest = []
    summary = IssueSummary()
    started = time.monotonic()
    last_emit = started
    visited = 0
    iterators = []
    current_index = 0
    retained_files = 0

    def listen():
        for line in sys.stdin:
            try:
                if json.loads(line).get("cancel"):
                    cancelled.set()
                    break
            except (ValueError, TypeError):
                pass

    threading.Thread(target=listen, daemon=True).start()

    def issue(path, reason, skip=False, code=None, label=None, directory=None):
        key = "skipped" if skip else "errors"
        details = "skipDetails" if skip else "errorDetails"
        state[key] += 1
        if nodes:
            nodes[current_index]["directSkipped" if skip else "directErrors"] += 1
        if code is None:
            code, label = error_category(reason)
        summary.add(key, code, label, directory if directory is not None else os.path.dirname(path))
        if len(state[details]) < 100:
            state[details].append({"path": path, "reason": str(reason).replace("\\\\?\\", "")[:300]})

    try:
        root = validate_root(config["root"])
        state["root"] = root
        root_node = {"id": "root", "parentId": None, "path": root, "name": os.path.basename(root) or root,
                     "bytes": 0, "ownBytes": 0, "ownFileCount": 0, "fileDetailsCount": 0,
                     "directErrors": 0, "directSkipped": 0, "_depth": 0, "_seen": 0, "_enumerated": False}
        nodes.append(root_node)
        state["dirsCount"] = 1
        # Directory iterators bound memory to directory depth; no recursive call stack.
        iterators.append((0, os.scandir(filesystem_path(root))))
        emit(state)
        while iterators and not cancelled.is_set():
            if visited >= max_entries or time.monotonic() - started >= max_seconds:
                state["truncated"] = True
                state["warnings"].append("已达到扫描条目或时间上限，当前结果仅代表已扫描部分。")
                break
            index, iterator = iterators[-1]
            current_index = index
            try:
                entry = next(iterator)
            except StopIteration:
                nodes[index]["_enumerated"] = True
                iterator.close()
                iterators.pop()
                continue
            except OSError as exc:
                issue(nodes[index]["path"], exc, directory=nodes[index]["path"])
                iterator.close()
                iterators.pop()
                continue
            visited += 1
            nodes[index]["_seen"] += 1
            display_path = os.path.join(nodes[index]["path"], entry.name)
            issue_directory = nodes[index]["path"]
            state["currentPath"] = display_path
            try:
                info = entry.stat(follow_symlinks=False)
                attributes = getattr(info, "st_file_attributes", 0)
                if stat.S_ISLNK(info.st_mode) or attributes & REPARSE:
                    code, label = reparse_category(info)
                    issue(display_path, "reparse / symbolic link skipped", True, code, label, issue_directory)
                    continue
                if attributes & OFFLINE:
                    issue(display_path, "offline / cloud placeholder skipped", True, "offline", "离线或云占位", issue_directory)
                    continue
                if stat.S_ISDIR(info.st_mode):
                    if len(nodes) >= max_dirs:
                        state["truncated"] = True
                        state["warnings"].append("已达到目录索引上限，当前结果仅代表已扫描部分。")
                        break
                    issue_directory = display_path
                    child_iterator = os.scandir(filesystem_path(display_path))
                    child_index = len(nodes)
                    nodes.append({"id": str(child_index), "parentId": nodes[index]["id"], "path": display_path,
                                  "name": entry.name, "bytes": 0, "ownBytes": 0, "ownFileCount": 0, "fileDetailsCount": 0,
                                  "directErrors": 0, "directSkipped": 0, "_seen": 0, "_enumerated": False,
                                  "_parent": index, "_depth": nodes[index]["_depth"] + 1})
                    state["dirsCount"] += 1
                    iterators.append((child_index, child_iterator))
                elif stat.S_ISREG(info.st_mode):
                    size = info.st_size
                    nodes[index]["ownBytes"] += size
                    state["totalBytes"] += size
                    state["filesCount"] += 1
                    node = nodes[index]
                    node["ownFileCount"] += 1
                    if measure_allocated:
                        if allocation["measuredFiles"] + allocation["errors"] >= max_allocation_files:
                            allocation["omittedFiles"] += 1
                            node["_allocationErrors"] = node.get("_allocationErrors", 0) + 1
                        else:
                            try:
                                identity, allocated = allocation_reader.measure(display_path, size)
                                allocation["measuredFiles"] += 1
                                if identity in identities:
                                    allocation["duplicatePaths"] += 1
                                else:
                                    identities.add(identity)
                                    allocation["uniqueFiles"] += 1
                                    allocation["knownAllocatedBytes"] += allocated
                                    allocation["knownDeduplicatedLogicalBytes"] += size
                                    node["_ownAllocatedBytes"] = node.get("_ownAllocatedBytes", 0) + allocated
                            except (OSError, ValueError, OverflowError):
                                allocation["errors"] += 1
                                node["_allocationErrors"] = node.get("_allocationErrors", 0) + 1
                    rank = (size, visited)
                    global_candidate = len(largest) < max_files or rank > largest[0][:2]
                    local = node.get("_fileHeap", [])
                    local_candidate = (len(local) < max_per_directory and retained_files < max_file_details) or (
                        bool(local) and (len(local) >= max_per_directory or retained_files >= max_file_details) and rank > local[0][:2])
                    # Most files enter neither bounded index. Avoid date conversion,
                    # extension classification and record allocation for those files.
                    if global_candidate or local_candidate:
                        item_kind, protected = kind_for(entry.name)
                        item = {"path": display_path, "name": entry.name, "bytes": size, "parentId": node["id"],
                                "modifiedAt": datetime.datetime.fromtimestamp(info.st_mtime, datetime.timezone.utc).isoformat(),
                                "kind": item_kind, "protected": protected}
                        heap_item = (*rank, item)
                        if global_candidate:
                            if len(largest) < max_files:
                                heapq.heappush(largest, heap_item)
                            else:
                                heapq.heapreplace(largest, heap_item)
                        if local_candidate:
                            if "_fileHeap" not in node:
                                node["_fileHeap"] = local
                            if len(local) < max_per_directory and retained_files < max_file_details:
                                heapq.heappush(local, heap_item)
                                retained_files += 1
                            else:
                                heapq.heapreplace(local, heap_item)
                else:
                    issue(display_path, "non-regular filesystem entry skipped", True, "nonregular", "其他特殊文件", issue_directory)
            except (OSError, ValueError, OverflowError) as exc:
                issue(display_path, exc, directory=issue_directory)
            now = time.monotonic()
            if now - last_emit >= 0.4:
                emit(state)
                last_emit = now
        state["status"] = "cancelled" if cancelled.is_set() else "completed"
        state["complete"] = state["status"] == "completed" and not state["truncated"] and state["errors"] == 0 and state["skipped"] == 0
        if state["errors"]:
            state["warnings"].append("部分路径读取失败，相关内容可能未计入索引；未提权。")
        if state["skipped"]:
            state["warnings"].append("已跳过重解析点、离线文件等条目，避免重复统计和下载云文件。")
        if state["status"] == "cancelled":
            state["warnings"].append("扫描已取消，以下为已扫描部分。")
    except Exception as exc:
        state["status"] = "failed"
        state["error"] = str(exc).replace("\\\\?\\", "")
        issue(config["root"], exc, directory=config["root"])
    finally:
        for _, iterator in iterators:
            iterator.close()
        for node in reversed(nodes):
            node["bytes"] += node["ownBytes"]
            errors = node["directErrors"] + node.pop("_childErrors", 0)
            skipped = node["directSkipped"] + node.pop("_childSkipped", 0)
            child_partial = node.pop("_childPartial", False)
            complete = node["_enumerated"] and not errors and not skipped and not child_partial
            node["coverage"] = {"status": "complete" if complete else (
                "unscanned" if not node["_seen"] and not errors and not skipped else "partial"), "errors": errors, "skipped": skipped}
            if measure_allocated:
                own_allocated = node.pop("_ownAllocatedBytes", 0)
                direct_allocation_errors = node.pop("_allocationErrors", 0)
                allocation_errors = direct_allocation_errors + node.pop("_childAllocationErrors", 0)
                known_allocated = own_allocated + node.pop("_childAllocatedBytes", 0)
                node["ownAllocatedBytes"] = own_allocated if node["_enumerated"] and not node["directErrors"] and not node["directSkipped"] and not direct_allocation_errors else None
                node["knownAllocatedBytes"] = known_allocated
                node["allocatedBytes"] = known_allocated if complete and not allocation_errors else None
            parent = node.pop("_parent", None)
            if parent is not None:
                if measure_allocated:
                    nodes[parent]["_childAllocatedBytes"] = nodes[parent].get("_childAllocatedBytes", 0) + known_allocated
                    nodes[parent]["_childAllocationErrors"] = nodes[parent].get("_childAllocationErrors", 0) + allocation_errors
                nodes[parent]["bytes"] += node["bytes"]
                nodes[parent]["_childErrors"] = nodes[parent].get("_childErrors", 0) + errors
                nodes[parent]["_childSkipped"] = nodes[parent].get("_childSkipped", 0) + skipped
                nodes[parent]["_childPartial"] = nodes[parent].get("_childPartial", False) or not complete
            node.pop("_seen", None)
            node.pop("_enumerated", None)
        if len(nodes) > max_display_dirs:
            # Parent totals are always >= their descendants. A depth tiebreaker
            # preserves ancestor closure even for chains of equal-sized folders.
            ranked = sorted(range(len(nodes)), key=lambda i: (-nodes[i]["bytes"], nodes[i]["_depth"], i))
            retained = set(ranked[:max_display_dirs])
            displayed = [node for i, node in enumerate(nodes) if i in retained]
            state["displayPruned"] = True
            state["displayOmittedDirectories"] = len(nodes) - len(displayed)
            state["warnings"].append(f"目录视图仅展示体积最大的 {max_display_dirs} 个目录，其余目录已折叠；已扫描总量与大文件排行仍包含折叠内容。")
        else:
            displayed = nodes
        by_id = {node["id"]: node for node in displayed}
        for node in displayed:
            node["omittedBytes"] = node["bytes"] - node["ownBytes"]
        for node in displayed:
            if node["parentId"] in by_id:
                by_id[node["parentId"]]["omittedBytes"] -= node["bytes"]
        file_details = []
        for node in nodes:
            details = node.pop("_fileHeap", [])
            if node["id"] in by_id:
                node["fileDetailsCount"] = len(details)
                file_details.extend(item[2] for item in sorted(details, reverse=True))
            node.pop("_depth", None)
        state["fileDetails"] = file_details
        state["fileDetailPolicy"] = {"maxPerDirectory": max_per_directory, "maxTotal": max_file_details,
                                     "retained": len(file_details), "omitted": max(0, state["filesCount"] - len(file_details))}
        if measure_allocated:
            allocation_complete = state["complete"] and not allocation["errors"] and not allocation["omittedFiles"]
            allocation["status"] = "complete" if allocation_complete else (
                "partial" if allocation["measuredFiles"] else "unavailable")
            if allocation_complete:
                allocation["allocatedBytes"] = allocation["knownAllocatedBytes"]
                allocation["deduplicatedLogicalBytes"] = allocation["knownDeduplicatedLogicalBytes"]
            state["warnings"].append("可选分配量仅在本次扫描范围内按文件身份去重，归属首个遇到的路径；不代表删除某个链接即可释放这些空间。")
            if not allocation_complete:
                state["warnings"].append("分配量测量存在遗漏、失败或扫描边界；总分配量保持未知，已测部分单独展示。")
        state["directories"] = displayed
        state["largeFiles"] = [entry[2] for entry in sorted(largest, reverse=True)]
        state["issueSummary"] = summary.finalize()
        state["finishedAt"] = utc()
        state["currentPath"] = ""
        emit(state)


if __name__ == "__main__":
    main()
