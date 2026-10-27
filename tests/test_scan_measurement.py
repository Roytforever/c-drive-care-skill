"""Scanner coverage/allocation failure regression tests, synthetic files only."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("scan_worker_regression", PROJECT / "server" / "scan-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ScanMeasurementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="liubai-scan-unit-")
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def scan(self, **config):
        states = []
        worker.cancelled.clear()
        with mock.patch.object(worker.sys, "stdin", io.StringIO(json.dumps({"root": str(self.root), **config}) + "\n")), mock.patch.object(worker, "emit", lambda state: states.append(json.loads(json.dumps(state)))):
            worker.main()
        return states[-1]

    def test_denied_child_marks_parent_without_contaminating_sibling(self):
        denied = self.root / "denied"
        safe = self.root / "safe"
        denied.mkdir(); safe.mkdir()
        (safe / "one.bin").write_bytes(b"abc")
        original = worker.os.scandir
        def directory(path):
            if os.path.normcase(os.path.abspath(str(path).replace("\\\\?\\", ""))) == os.path.normcase(str(denied)):
                raise PermissionError("synthetic denied branch")
            return original(path)
        with mock.patch.object(worker.os, "scandir", directory):
            state = self.scan()
        self.assertEqual(state["errors"], 1)
        by_name = {row["name"]: row for row in state["directories"]}
        self.assertEqual(by_name["safe"]["coverage"], {"status": "complete", "errors": 0, "skipped": 0})
        self.assertEqual(state["directories"][0]["coverage"], {"status": "partial", "errors": 1, "skipped": 0})
        self.assertEqual(state["directories"][0]["directErrors"], 1)

    def test_measurement_failure_keeps_total_unknown_without_failing_logical_scan(self):
        (self.root / "one.bin").write_bytes(b"abc")
        reader = mock.Mock()
        reader.measure.side_effect = OSError("synthetic unsupported allocation API")
        with mock.patch.object(worker, "AllocationReader", return_value=reader):
            state = self.scan(measureAllocated=True)
        self.assertTrue(state["complete"])
        self.assertEqual(state["errors"], 0)
        self.assertEqual(state["totalBytes"], 3)
        self.assertEqual(state["allocation"]["status"], "unavailable")
        self.assertEqual(state["allocation"]["errors"], 1)
        self.assertIsNone(state["allocation"]["allocatedBytes"])
        self.assertIsNone(state["directories"][0]["allocatedBytes"])
        self.assertEqual(state["directories"][0]["coverage"]["status"], "complete")

    def test_unrequested_allocation_does_not_open_metadata_handles(self):
        (self.root / "one.bin").write_bytes(b"abc")
        with mock.patch.object(worker, "AllocationReader", side_effect=AssertionError("must stay opt in")):
            state = self.scan()
        self.assertFalse(state["allocation"]["requested"])
        self.assertEqual(state["allocation"]["status"], "not-measured")
        self.assertIsNone(state["allocation"]["allocatedBytes"])


if __name__ == "__main__":
    unittest.main()
