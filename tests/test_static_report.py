"""Behavior tests for the provider-neutral static report command."""
import json
import copy
import base64
import gzip
import errno
import os
import contextlib
import io
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from html.parser import HTMLParser

from scripts import generate_report as generator

PROJECT = pathlib.Path(__file__).resolve().parents[1]


class EmbeddedData(HTMLParser):
    def __init__(self):
        super().__init__()
        self.inside = False
        self.parts = []
        self.script_ids = []
        self.encoding = None

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'script':
            self.script_ids.append(values.get('id'))
            self.inside = values.get('id') == 'liubai-report-data'
            if self.inside:
                self.encoding = values.get('data-encoding', 'json')

    def handle_endtag(self, tag):
        if tag == 'script':
            self.inside = False

    def handle_data(self, text):
        if self.inside:
            self.parts.append(text)


def old_scan(path='C:\\fixture'):
    return {'id': 'old-scan', 'status': 'completed', 'root': path,
            'startedAt': '2024-01-02T03:04:00Z', 'finishedAt': '2024-01-02T03:05:00Z',
            'filesCount': 1, 'dirsCount': 1, 'totalBytes': 7, 'errors': 0, 'skipped': 0,
            'complete': True, 'directories': [{'id': 'root', 'parentId': None, 'path': path,
                                               'name': path, 'bytes': 7, 'ownBytes': 7}],
            'largeFiles': [{'path': path + '\\one', 'name': 'one', 'bytes': 7}]}


class StaticReportTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix='liubai-static-test-')
        self.root = pathlib.Path(self.sandbox.name)
        self.template = self.root / 'template.html'
        self.template.write_text('<!doctype html><html><head><meta charset="utf-8"></head>'
                                 '<body><main id="root"></main><!--LIUBAI_REPORT_DATA-->'
                                 '<script id="fixture-runtime">/* offline fixture runtime */</script>'
                                 '</body></html>', encoding='utf-8')

    def tearDown(self):
        self.sandbox.cleanup()

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(PROJECT / 'run.py'), *map(str, args)],
                              cwd=self.root, capture_output=True, text=True, encoding='utf-8',
                              timeout=30)

    def generate(self, data, out_name='output', extra_args=()):
        snapshot = self.root / 'snapshot.json'
        snapshot.write_text(json.dumps(data), encoding='utf-8')
        out = self.root / out_name
        result = self.run_cli('--report-only', '--index', snapshot, '--out-dir', out,
                              '--template', self.template, *extra_args)
        self.assertEqual(result.returncode, 0, result.stderr)
        document = (out / 'report.html').read_text(encoding='utf-8')
        parsed = EmbeddedData()
        parsed.feed(document)
        encoded = ''.join(parsed.parts)
        if parsed.encoding == 'gzip-base64':
            encoded = gzip.decompress(base64.b64decode(encoded)).decode('utf-8')
        return result, out, document, parsed, json.loads(encoded)

    def test_snapshot_only_preserves_old_measurement_without_current_inventory(self):
        result, out, _, _, state = self.generate(old_scan())
        self.assertEqual(state['sourceMode'], 'snapshot')
        self.assertEqual(state['scan']['finishedAt'], '2024-01-02T03:05:00Z')
        self.assertEqual(state['scan']['totalBytes'], 7)
        self.assertEqual(state['drives'], [])
        self.assertTrue(state['report']['inventoryWarnings'])
        self.assertEqual(json.loads((out / 'index.json').read_text(encoding='utf-8')), state)
        summary = json.loads(result.stdout)
        self.assertEqual(summary['status'], 'completed')
        self.assertTrue(pathlib.Path(summary['report']).is_absolute())
        self.assertIsNone(summary.get('issueSummary'))

    def test_issue_summary_survives_rebuild_and_command_returns_bounded_summary(self):
        payload = old_scan()
        payload.update({'errors': 3, 'skipped': 1, 'complete': False,
                        'issueSummary': {'version': 1,
                            'errors': {'reasonCounts': [{'code': 'access_denied', 'label': '拒绝访问', 'count': 3}],
                                       'directories': [{'path': 'C:\\fixture\\private', 'count': 2}],
                                       'otherDirectoryEvents': 1},
                            'skipped': {'reasonCounts': [{'code': 'reparse', 'label': '重解析点', 'count': 1}],
                                        'directories': [{'path': 'C:\\fixture', 'count': 1}],
                                        'otherDirectoryEvents': 0}}})
        result, _, _, _, state = self.generate(payload)
        self.assertEqual(state['scan']['issueSummary'], payload['issueSummary'])
        summary = json.loads(result.stdout)
        self.assertFalse(summary['complete'])
        self.assertEqual(summary['issueSummary']['errors']['reasonCounts'], payload['issueSummary']['errors']['reasonCounts'])
        self.assertEqual(summary['issueSummary']['errors']['recordedDirectories'], 1)
        self.assertEqual(summary['issueSummary']['errors']['otherDirectoryEvents'], 1)
        self.assertNotIn('directories', summary['issueSummary']['errors'])

    def test_invalid_issue_summary_cannot_claim_a_complete_breakdown(self):
        base = old_scan()
        base.update({'errors': 3, 'skipped': 0, 'complete': False,
                     'issueSummary': {'version': 1,
                         'errors': {'reasonCounts': [{'code': 'access_denied', 'label': '拒绝访问', 'count': 3}],
                                    'directories': [{'path': 'C:\\fixture', 'count': 3}],
                                    'otherDirectoryEvents': 0},
                         'skipped': {'reasonCounts': [], 'directories': [], 'otherDirectoryEvents': 0}}})
        mutations = (
            lambda scan: scan['issueSummary']['errors']['reasonCounts'][0].update(count=2),
            lambda scan: scan['issueSummary']['errors']['directories'][0].update(count=2),
            lambda scan: scan['issueSummary']['errors'].update(otherDirectoryEvents=True),
            lambda scan: scan['issueSummary']['errors']['reasonCounts'][0].update(label=None),
        )
        for i, mutate in enumerate(mutations):
            with self.subTest(case=i):
                payload = copy.deepcopy(base)
                mutate(payload)
                source = self.root / f'bad-issue-summary-{i}.json'
                source.write_text(json.dumps(payload), encoding='utf-8')
                output = self.root / f'bad-issue-summary-output-{i}'
                result = self.run_cli('--report-only', '--index', source, '--out-dir', output,
                                      '--template', self.template)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((output / 'report.html').exists())

    def test_full_snapshot_preserves_original_capacities_and_strips_credentials_recursively(self):
        payload = {'scan': old_scan(), 'drives': [{'id': 'C:', 'totalBytes': 20, 'freeBytes': 13}],
                   'caches': [], 'csrfToken': 'top secret',
                   'history': [{'detail': 'keep history', 'confirmationText': 'hidden'}],
                   'operations': [{'kind': 'migrate', 'previousConfig': 'private', 'snapshot': {'secret': 1}}],
                   'report': {'inventoryWarnings': ['original warning']}}
        _, _, _, _, state = self.generate(payload)
        self.assertEqual(state['drives'], [{'id': 'C:', 'totalBytes': 20, 'freeBytes': 13}])
        self.assertNotIn('csrfToken', state)
        self.assertNotIn('confirmationText', state['history'][0])
        self.assertNotIn('snapshot', state['operations'][0])
        self.assertNotIn('previousConfig', state['operations'][0])
        self.assertIn('original warning', state['report']['inventoryWarnings'])

    def test_hostile_paths_round_trip_as_data_without_creating_another_script(self):
        hostile = '</script><script id="attack">alert(1)</script>&\u2028\u2029'
        _, _, document, parsed, state = self.generate(old_scan(hostile))
        self.assertEqual(parsed.script_ids, ['liubai-report-data', 'fixture-runtime'])
        self.assertEqual(state['scan']['root'], hostile)
        self.assertNotIn('<script id="attack">', document)
        self.assertNotIn('\u2028', document)
        self.assertNotIn('\u2029', document)

    def test_unfinished_or_invalid_snapshot_is_not_presented_as_success(self):
        for data in ({'arbitrary': 'value'}, {**old_scan(), 'status': 'running'}):
            snapshot = self.root / 'invalid.json'
            snapshot.write_text(json.dumps(data), encoding='utf-8')
            output = self.root / 'invalid-output'
            result = self.run_cli('--report-only', '--index', snapshot, '--out-dir', output,
                                  '--template', self.template)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((output / 'report.html').exists())

    def test_missing_template_fails_before_creating_outputs(self):
        snapshot = self.root / 'old.json'
        snapshot.write_text(json.dumps(old_scan()), encoding='utf-8')
        out = self.root / 'missing-output'
        result = self.run_cli('--report-only', '--index', snapshot, '--out-dir', out,
                              '--template', self.root / 'missing-template.html')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('模板', result.stderr)
        self.assertFalse(out.exists())

    def test_report_only_keeps_original_input_index_when_rendering_beside_it(self):
        output = self.root / 'beside-input'
        output.mkdir()
        source = output / 'index.json'
        original = json.dumps(old_scan(), indent=3)
        source.write_text(original, encoding='utf-8')
        result = self.run_cli('--report-only', '--index', source, '--out-dir', output,
                              '--template', self.template)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(source.read_text(encoding='utf-8'), original)
        self.assertTrue((output / 'report.html').exists())

    def test_scan_rejects_existing_output_before_starting_scan(self):
        out = self.root / 'existing-scan-output'
        out.mkdir()
        (out / 'index.json').write_bytes(b'preserve preexisting index')
        result = self.run_cli(self.root / 'nonexistent-scan-root', '--out-dir', out,
                              '--template', self.template)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('已存在', result.stderr)
        self.assertEqual((out / 'index.json').read_bytes(), b'preserve preexisting index')
        self.assertFalse((out / 'report.html').exists())

    def test_report_only_rejects_existing_html_and_preserves_both_inputs(self):
        out = self.root / 'existing-report'
        out.mkdir()
        source = out / 'index.json'
        original = json.dumps(old_scan(), indent=2)
        source.write_text(original, encoding='utf-8')
        (out / 'report.html').write_bytes(b'important existing report')
        result = self.run_cli('--report-only', '--index', source, '--out-dir', out,
                              '--template', self.template)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('已存在', result.stderr)
        self.assertEqual(source.read_text(encoding='utf-8'), original)
        self.assertEqual((out / 'report.html').read_bytes(), b'important existing report')

    def test_overwrite_must_be_explicit_and_never_rewrites_source_index(self):
        out = self.root / 'explicit-overwrite'
        out.mkdir()
        source = out / 'index.json'
        original = json.dumps(old_scan(), indent=2)
        source.write_text(original, encoding='utf-8')
        (out / 'report.html').write_bytes(b'prior report')
        result = self.run_cli('--report-only', '--index', source, '--out-dir', out,
                              '--template', self.template, '--overwrite')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(source.read_text(encoding='utf-8'), original)
        self.assertIn('<html>', (out / 'report.html').read_text(encoding='utf-8'))

    def test_overwrite_replaces_existing_artifacts_only_when_requested(self):
        out = self.root / 'overwrite-both'
        out.mkdir()
        (out / 'index.json').write_bytes(b'prior index')
        (out / 'report.html').write_bytes(b'prior report')
        source = self.root / 'old-index.json'
        source.write_text(json.dumps(old_scan()), encoding='utf-8')
        result = self.run_cli('--report-only', '--index', source, '--out-dir', out,
                              '--template', self.template, '--overwrite')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((out / 'index.json').read_text(encoding='utf-8'))['scan']['totalBytes'], 7)
        self.assertTrue((out / 'report.html').read_text(encoding='utf-8').startswith('<!doctype html>'))

    def test_overwrite_is_supported_for_new_scans_with_explicit_flag(self):
        scan_root = self.root / 'overwrite-scan-input'
        scan_root.mkdir()
        (scan_root / 'fixture.txt').write_bytes(b'fixture')
        out = self.root / 'overwrite-scan-output'
        out.mkdir()
        (out / 'index.json').write_bytes(b'prior index')
        (out / 'report.html').write_bytes(b'prior report')
        result = self.run_cli(scan_root, '--out-dir', out, '--template', self.template, '--overwrite')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((out / 'index.json').read_text(encoding='utf-8'))['scan']['totalBytes'], 7)
        self.assertTrue((out / 'report.html').read_text(encoding='utf-8').startswith('<!doctype html>'))

    def test_overwrite_rejects_output_directory_conflicts_before_scan(self):
        out = self.root / 'overwrite-directory-conflict'
        out.mkdir()
        (out / 'index.json').write_bytes(b'prior index')
        (out / 'report.html').mkdir()
        result = self.run_cli(self.root / 'nonexistent-scan-root', '--out-dir', out,
                              '--template', self.template, '--overwrite')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('目录', result.stderr)
        self.assertEqual((out / 'index.json').read_bytes(), b'prior index')
        self.assertTrue((out / 'report.html').is_dir())

    def test_input_named_report_html_is_never_overwritten(self):
        out = self.root / 'same-input-and-report'
        out.mkdir()
        source = out / 'report.html'
        original = json.dumps(old_scan(), indent=2)
        source.write_text(original, encoding='utf-8')
        result = self.run_cli('--report-only', '--index', source, '--out-dir', out,
                              '--template', self.template, '--overwrite')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(source.read_text(encoding='utf-8'), original)
        self.assertFalse((out / 'index.json').exists())

    def test_atomic_create_does_not_replace_a_concurrently_created_target(self):
        target = self.root / 'racing-report.html'
        real_link = os.link
        def racing_link(source, destination):
            pathlib.Path(destination).write_text('concurrent user content', encoding='utf-8')
            return real_link(source, destination)
        with mock.patch.object(generator.os, 'link', side_effect=racing_link):
            with self.assertRaises(FileExistsError):
                generator.atomic_write(target, 'new report', overwrite=False)
        self.assertEqual(target.read_text(encoding='utf-8'), 'concurrent user content')

    def test_filesystem_without_hardlinks_still_uses_exclusive_creation(self):
        target = self.root / 'no-hardlinks.html'
        with mock.patch.object(generator.os, 'link', side_effect=OSError(errno.EOPNOTSUPP, 'hardlinks unavailable')):
            generator.atomic_write(target, 'new report', overwrite=False)
            with self.assertRaises(FileExistsError):
                generator.atomic_write(target, 'replacement', overwrite=False)
        self.assertEqual(target.read_text(encoding='utf-8'), 'new report')

    def test_second_output_race_preserves_concurrent_file_and_reports_partial_output(self):
        source = self.root / 'race-source.json'
        source.write_text(json.dumps(old_scan()), encoding='utf-8')
        out = self.root / 'race-output'
        real_link = os.link
        def racing_link(temporary, destination):
            if pathlib.Path(destination).name == 'report.html':
                pathlib.Path(destination).write_text('other process report', encoding='utf-8')
            return real_link(temporary, destination)
        stderr = io.StringIO()
        with mock.patch.object(generator.os, 'link', side_effect=racing_link), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
            result = generator.main(['--report-only', '--index', str(source), '--out-dir', str(out),
                                     '--template', str(self.template)])
        self.assertEqual(result, 1)
        self.assertEqual((out / 'report.html').read_text(encoding='utf-8'), 'other process report')
        self.assertTrue((out / 'index.json').exists())
        self.assertIn('已写入的产物', stderr.getvalue())

    def test_cancelled_snapshot_stays_partial_and_command_returns_non_success_status(self):
        source = self.root / 'cancelled.json'
        payload = {**old_scan(), 'status': 'cancelled', 'complete': False,
                   'warnings': ['Cancelled by user']}
        source.write_text(json.dumps(payload), encoding='utf-8')
        output = self.root / 'cancelled-output'
        result = self.run_cli('--report-only', '--index', source, '--out-dir', output,
                              '--template', self.template)
        self.assertEqual(result.returncode, 2, result.stderr)
        state = json.loads((output / 'index.json').read_text(encoding='utf-8'))
        self.assertEqual(state['scan']['status'], 'cancelled')
        self.assertFalse(state['scan']['complete'])

    def test_broken_parent_links_and_cycles_fail_instead_of_forming_unbrowseable_tree(self):
        for parent_id in ('missing', 'root'):
            payload = old_scan()
            payload['directories'][0]['parentId'] = parent_id
            source = self.root / 'broken-tree.json'
            source.write_text(json.dumps(payload), encoding='utf-8')
            output = self.root / ('broken-' + parent_id)
            result = self.run_cli('--report-only', '--index', source, '--out-dir', output,
                                  '--template', self.template)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((output / 'report.html').exists())

    def test_new_scan_counts_real_fixture_files_and_does_not_modify_them(self):
        scan_root = self.root / 'scan-input'
        (scan_root / 'nested').mkdir(parents=True)
        one = scan_root / 'one.txt'
        two = scan_root / 'nested' / 'two.bin'
        one.write_bytes(b'1234567')
        two.write_bytes(b'12345678901')
        before = [(p, p.read_bytes(), p.stat().st_mtime_ns) for p in (one, two)]
        out = self.root / 'scan-output'
        result = self.run_cli(scan_root, '--out-dir', out, '--template', self.template)
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads((out / 'index.json').read_text(encoding='utf-8'))
        self.assertEqual(state['sourceMode'], 'scan')
        self.assertEqual(state['scan']['totalBytes'], 18)
        self.assertEqual(state['scan']['filesCount'], 2)
        self.assertEqual(state['scan']['dirsCount'], 2)
        self.assertEqual(state['scan']['status'], 'completed')
        self.assertTrue(state['scan']['complete'])
        for p, content, mtime in before:
            self.assertEqual(p.read_bytes(), content)
            self.assertEqual(p.stat().st_mtime_ns, mtime)

    def test_large_payload_is_gzip_embedded_and_reconstructs_the_full_uncompressed_index(self):
        payload = {'scan': old_scan(), 'report': {'detail': '</script>中文\u2028' * 140000}}
        _, out, document, parsed, state = self.generate(payload)
        self.assertEqual(parsed.encoding, 'gzip-base64')
        self.assertEqual(state['report']['detail'], payload['report']['detail'])
        self.assertEqual(json.loads((out / 'index.json').read_text(encoding='utf-8')), state)
        self.assertLess(len(document.encode('utf-8')), (out / 'index.json').stat().st_size / 4)

    def test_no_compress_retains_large_raw_json_for_older_browsers(self):
        payload = {'scan': old_scan(), 'report': {'detail': 'older browser data ' * 80000}}
        _, out, _, parsed, state = self.generate(payload, extra_args=('--no-compress',))
        self.assertEqual(parsed.encoding, 'json')
        self.assertEqual(state['report']['detail'], payload['report']['detail'])
        self.assertEqual(json.loads((out / 'index.json').read_text(encoding='utf-8')), state)


if __name__ == '__main__':
    unittest.main()
