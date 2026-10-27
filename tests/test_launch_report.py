"""Safety tests for convenience launchers; use only synthetic temporary data."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


PROJECT = Path(__file__).resolve().parents[1]
LAUNCHER = PROJECT / 'scripts' / 'launch_report.py'


class LaunchReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='liubai-launch-test-')
        self.root = Path(self.tmp.name)
        self.input = self.root / 'synthetic-input'
        self.input.mkdir()
        (self.input / 'fixture.txt').write_text('synthetic', encoding='utf-8')
        self.output = self.root / 'reports'

    def tearDown(self):
        self.tmp.cleanup()

    def launch(self, *extra):
        return subprocess.run([sys.executable, str(LAUNCHER), '--report-dir', str(self.output), *extra],
                              cwd=self.root, capture_output=True, text=True, encoding='utf-8', timeout=60)

    def test_repeated_scans_use_new_directories_without_overwriting_existing_files(self):
        self.output.mkdir()
        old_html = self.output / 'report.html'
        old_index = self.output / 'index.json'
        old_html.write_text('existing report', encoding='utf-8')
        old_index.write_text('existing index', encoding='utf-8')
        results = []
        for _ in range(2):
            run = self.launch('--root', str(self.input))
            self.assertEqual(run.returncode, 0, run.stderr)
            result = json.loads(run.stdout)
            self.assertEqual(result['filesCount'], 1)
            self.assertTrue(Path(result['report']).is_file())
            self.assertTrue(Path(result['report']).resolve().is_relative_to((self.output / 'runs').resolve()))
            results.append(result)
        self.assertNotEqual(results[0]['report'], results[1]['report'])
        self.assertEqual(old_html.read_text(encoding='utf-8'), 'existing report')
        self.assertEqual(old_index.read_text(encoding='utf-8'), 'existing index')

    def test_preview_rebuilds_latest_snapshot_in_new_directory_and_preserves_source(self):
        first = self.launch('--root', str(self.input))
        self.assertEqual(first.returncode, 0, first.stderr)
        (self.input / 'second.txt').write_text('another synthetic file', encoding='utf-8')
        second = self.launch('--root', str(self.input))
        self.assertEqual(second.returncode, 0, second.stderr)
        prior = json.loads(second.stdout)
        original = Path(prior['index']).read_bytes()
        preview = self.launch('--preview')
        self.assertEqual(preview.returncode, 0, preview.stderr)
        result = json.loads(preview.stdout)
        self.assertEqual(result['sourceMode'], 'snapshot')
        self.assertEqual(result['filesCount'], 2)
        self.assertEqual(result['scanFinishedAt'], prior['scanFinishedAt'])
        self.assertNotEqual(result['report'], prior['report'])
        self.assertEqual(Path(prior['index']).read_bytes(), original)

    def test_preview_without_snapshot_explains_the_problem_without_creating_output(self):
        result = self.launch('--preview')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('快照', result.stderr)
        self.assertFalse(self.output.exists())

    def test_preview_rejects_linked_runs_directory(self):
        self.output.mkdir()
        target = self.root / 'outside-runs'
        target.mkdir()
        link = self.output / 'runs'
        try:
            os.symlink(target, link, target_is_directory=True)
        except OSError as error:
            if os.name != 'nt':
                self.skipTest('Cannot create temporary link: ' + str(error))
            created = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(link), str(target)],
                                     capture_output=True, timeout=20)
            self.assertEqual(created.returncode, 0)
        self.assertTrue(link.resolve().is_relative_to(self.root.resolve()))
        result = self.launch('--preview')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('链接', result.stderr)
        self.assertEqual(list(target.iterdir()), [])

    def test_preview_ignores_linked_run_directory(self):
        first = self.launch('--root', str(self.input))
        self.assertEqual(first.returncode, 0, first.stderr)
        target = self.root / 'outside-run'
        target.mkdir()
        (target / 'index.json').write_text('must not be read', encoding='utf-8')
        link = self.output / 'runs' / 'linked-run'
        try:
            os.symlink(target, link, target_is_directory=True)
        except OSError as error:
            if os.name != 'nt':
                self.skipTest('Cannot create temporary link: ' + str(error))
            created = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(link), str(target)],
                                     capture_output=True, timeout=20)
            self.assertEqual(created.returncode, 0)
        result = self.launch('--preview')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['filesCount'], 1)


if __name__ == '__main__':
    unittest.main()
