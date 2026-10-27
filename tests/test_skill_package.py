"""Packaging tests run only against isolated, synthetic data."""
import json
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import uuid
import zipfile

PROJECT = Path(__file__).resolve().parents[1]
PACKAGER = PROJECT / 'scripts' / 'package_skill.py'


class SkillPackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='liubai-package-test-')
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def package(self, destination):
        return subprocess.run([sys.executable, '-E', str(PACKAGER), '--output', str(destination)],
                              cwd=self.root, capture_output=True, text=True, encoding='utf-8', timeout=60)

    def test_archive_is_self_contained_and_works_outside_source_tree(self):
        archive = self.root / 'liubai-skill.zip'
        result = self.package(archive)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads(result.stdout)
        self.assertEqual(Path(manifest['archive']), archive)
        self.assertEqual(manifest['sha256'], hashlib.sha256(archive.read_bytes()).hexdigest())
        required = {
            'liubai-storage/SKILL.md',
            'liubai-storage/install.py',
            'liubai-storage/manifest.json',
            'liubai-storage/LICENSE',
            'liubai-storage/THIRD_PARTY_NOTICES.md',
            'liubai-storage/runtime/run.py',
            'liubai-storage/runtime/doctor.py',
            'liubai-storage/runtime/scripts/generate_report.py',
            'liubai-storage/runtime/scripts/cache_inventory.py',
            'liubai-storage/runtime/server/scan-worker.py',
            'liubai-storage/runtime/report-assets/template.html',
        }
        with zipfile.ZipFile(archive) as package:
            names = set(package.namelist())
            self.assertEqual(set(manifest['files']), names)
            self.assertTrue(required <= names)
            self.assertTrue(all(name.startswith('liubai-storage/') for name in names))
            self.assertFalse(any(part in {'report', '.liubai', 'node_modules', '__pycache__'}
                                 for name in names for part in Path(name).parts))
            for name in names:
                self.assertNotIn(str(PROJECT).encode('utf-8'), package.read(name))
                self.assertNotIn((str(Path.home()) + os.sep).encode('utf-8'), package.read(name))
            package.extractall(self.root / 'installed')

        runtime = self.root / 'installed' / 'liubai-storage' / 'runtime'
        doctor = subprocess.run([sys.executable, '-E', str(runtime / 'doctor.py')], cwd=self.root,
                                capture_output=True, text=True, encoding='utf-8', timeout=20)
        self.assertEqual(doctor.returncode, 0, doctor.stderr)
        health = json.loads(doctor.stdout)
        self.assertTrue(health['runtimeReady'])
        sample = self.root / 'fixture-input'
        sample.mkdir()
        sample_file = sample / 'hello.txt'
        sample_file.write_text('fixture-only', encoding='utf-8')
        before = sample_file.read_bytes(), sample_file.stat().st_mtime_ns
        report = self.root / 'fixture-output'
        run = subprocess.run([sys.executable, '-E', str(runtime / 'run.py'), str(sample),
                              '--out-dir', str(report)], cwd=self.root, capture_output=True,
                             text=True, encoding='utf-8', timeout=60)
        self.assertEqual(run.returncode, 0, run.stderr)
        output = json.loads(run.stdout)
        self.assertEqual(output['filesCount'], 1)
        self.assertTrue((report / 'report.html').is_file())
        self.assertEqual(before, (sample_file.read_bytes(), sample_file.stat().st_mtime_ns))

    def test_existing_archive_is_never_overwritten(self):
        archive = self.root / 'existing.zip'
        archive.write_bytes(b'important existing file')
        result = self.package(archive)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(archive.read_bytes(), b'important existing file')

    def test_missing_or_relative_destination_fails_without_creating_files(self):
        relative = self.package(Path('relative.zip'))
        self.assertNotEqual(relative.returncode, 0)
        self.assertFalse((self.root / 'relative.zip').exists())
        missing = self.package(self.root / 'missing-parent' / 'skill.zip')
        self.assertNotEqual(missing.returncode, 0)
        self.assertFalse((self.root / 'missing-parent').exists())

    def test_generated_archive_is_reproducible_for_the_same_inputs(self):
        a, b = self.root / 'first.zip', self.root / 'second.zip'
        self.assertEqual(self.package(a).returncode, 0)
        time.sleep(2.1)  # ZIP timestamps have two-second resolution.
        self.assertEqual(self.package(b).returncode, 0)
        self.assertEqual(hashlib.sha256(a.read_bytes()).digest(), hashlib.sha256(b.read_bytes()).digest())

    def test_private_output_and_missing_runtime_are_rejected(self):
        private_output = PROJECT / '.liubai' / ('forbidden-' + uuid.uuid4().hex + '.zip')
        result = self.package(private_output)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(private_output.exists())
        source_clone = self.root / 'source' / 'scripts'
        source_clone.mkdir(parents=True)
        copy = source_clone / 'package_skill.py'
        copy.write_bytes(PACKAGER.read_bytes())
        output = self.root / 'missing-runtime.zip'
        missing = subprocess.run([sys.executable, '-E', str(copy), '--output', str(output)], cwd=self.root,
                                 capture_output=True, text=True, encoding='utf-8', timeout=20)
        self.assertNotEqual(missing.returncode, 0)
        self.assertFalse(output.exists())

    def test_reparse_sources_are_rejected_before_they_are_read(self):
        spec = importlib.util.spec_from_file_location('liubai_packager_test', PACKAGER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        target = PROJECT / 'skills' / 'liubai-storage' / 'SKILL.md'
        real_lstat = os.lstat
        def simulated_lstat(path):
            if Path(path) == target:
                return type('FakeStat', (), {'st_mode': 0o100644, 'st_file_attributes': 0x400})()
            return real_lstat(path)
        with mock.patch.object(module.os, 'lstat', side_effect=simulated_lstat):
            with self.assertRaisesRegex(ValueError, '重解析点'):
                module.no_reparse(target)

    def test_installer_check_dry_run_install_and_conflict(self):
        archive = self.root / 'release.zip'
        result = self.package(archive)
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(archive) as package:
            package.extractall(self.root / 'extracted')
        source = self.root / 'extracted' / 'liubai-storage'
        # Unknown files are not allowed to leak into installed skill packages.
        (source / 'private-snapshot.json').write_text('fixture private data', encoding='utf-8')
        target = self.root / '中文 技能空格' / 'skills'
        target.mkdir(parents=True)
        installer = source / 'install.py'
        def invoke(*args):
            return subprocess.run([sys.executable, '-E', str(installer), '--target', str(target), *args],
                                  cwd=self.root, capture_output=True, text=True, encoding='utf-8', timeout=30)
        for mode in ('--check', '--dry-run'):
            result = invoke(mode)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['status'], 'ready')
            self.assertFalse((target / 'liubai-storage').exists())
        result = invoke('--install')
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = target / 'liubai-storage'
        self.assertEqual(json.loads(result.stdout)['status'], 'installed')
        self.assertTrue((installed / 'runtime' / 'run.py').is_file())
        self.assertFalse((installed / 'private-snapshot.json').exists())
        sentinel = installed / 'keep-existing.txt'
        sentinel.write_text('preserve', encoding='utf-8')
        repeated = invoke('--install')
        self.assertNotEqual(repeated.returncode, 0)
        self.assertEqual(sentinel.read_text(encoding='utf-8'), 'preserve')
        conflict = json.loads(repeated.stdout or repeated.stderr)
        self.assertEqual(conflict['status'], 'conflict')
        self.assertEqual(conflict['existingVersion'], '0.2.0')

    def test_installer_rejects_targets_within_source_or_symlink(self):
        archive = self.root / 'release.zip'
        self.assertEqual(self.package(archive).returncode, 0)
        with zipfile.ZipFile(archive) as package:
            package.extractall(self.root / 'extracted')
        source = self.root / 'extracted' / 'liubai-storage'
        command = [sys.executable, '-E', str(source / 'install.py')]
        nested = subprocess.run(command + ['--target', str(source / 'runtime'), '--check'],
                                capture_output=True, text=True, encoding='utf-8', timeout=20)
        self.assertNotEqual(nested.returncode, 0)
        real_target = self.root / 'real-target'
        real_target.mkdir()
        self.assertTrue(real_target.resolve().is_relative_to(self.root.resolve()))
        link_target = self.root / 'linked-target'
        try:
            os.symlink(real_target, link_target, target_is_directory=True)
        except OSError as error:
            if os.name != 'nt':
                self.skipTest('Cannot create temporary test link: ' + str(error))
            # Windows junctions can be created without symlink privilege; both
            # the link and its target are inside this test's temporary root.
            created = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(link_target), str(real_target)],
                                     capture_output=True, timeout=20)
            self.assertEqual(created.returncode, 0, 'Could not create temporary junction')
        self.assertTrue(link_target.resolve().is_relative_to(self.root.resolve()))
        linked = subprocess.run(command + ['--target', str(link_target), '--install'],
                                capture_output=True, text=True, encoding='utf-8', timeout=20)
        self.assertNotEqual(linked.returncode, 0)
        self.assertFalse((real_target / 'liubai-storage').exists())

    def test_installer_rejects_missing_target_and_bad_manifest_without_writing(self):
        archive = self.root / 'release.zip'
        self.assertEqual(self.package(archive).returncode, 0)
        with zipfile.ZipFile(archive) as package:
            package.extractall(self.root / 'extracted')
        source = self.root / 'extracted' / 'liubai-storage'
        command = [sys.executable, '-E', str(source / 'install.py')]
        missing = self.root / 'not-created'
        result = subprocess.run(command + ['--target', str(missing), '--check'],
                                capture_output=True, text=True, encoding='utf-8', timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(missing.exists())
        target = self.root / 'existing-parent'
        target.mkdir()
        for bad in ('{"format":1,"name":"other","version":"0.1.0"}',
                    '{"format":true,"name":"liubai-storage","version":"0.1.0"}'):
            (source / 'manifest.json').write_text(bad, encoding='utf-8')
            result = subprocess.run(command + ['--target', str(target), '--install'],
                                    capture_output=True, text=True, encoding='utf-8', timeout=20)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((target / 'liubai-storage').exists())


if __name__ == '__main__':
    unittest.main()
