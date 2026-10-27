"""Read-only configuration discovery using synthetic directories only."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from scripts.cache_inventory import discover_caches, read_setting


class CacheInventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='liubai-inventory-test-')
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / 'home'; self.home.mkdir()
        self.local = self.home / 'AppData' / 'Local'
        self.roaming = self.home / 'AppData' / 'Roaming'
        self.env = {'LOCALAPPDATA':str(self.local),'APPDATA':str(self.roaming),'PROGRAMDATA':str(self.root/'ProgramData')}
        self.scan = {'root':str(self.home),'complete':False,'directories':[]}

    def tearDown(self): self.tmp.cleanup()

    def write(self,path,text):
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(text,encoding='utf-8'); return path

    def discover(self):
        return {x['id']:x for x in discover_caches(self.scan,env=self.env,home=self.home)}

    def test_user_config_path_and_environment_precedence_without_credentials(self):
        configured=self.root/'custom npm'; configured.mkdir()
        p=self.write(self.home/'.npmrc',f'cache={configured}\n//registry/:_authToken=private-fixture\n')
        item=self.discover()['npm']
        self.assertEqual(item['path'],str(configured)); self.assertEqual(item['source'],'config')
        self.assertEqual(item['configPath'],str(p)); self.assertEqual(item['evidenceStatus'],'configured')
        self.assertTrue(item['protected']); self.assertIsNone(item['bytes'])
        self.assertFalse(item['inScanScope']); self.assertEqual(item['coverage']['status'],'unscanned')
        self.assertNotIn('private-fixture',json.dumps(item))
        override=self.root/'env npm'; override.mkdir(); self.env['npm_config_cache']=str(override)
        item=self.discover()['npm']; self.assertEqual(item['path'],str(override)); self.assertEqual(item['source'],'environment')

    def test_pip_user_site_and_explicit_configuration_priority(self):
        user=self.root/'user-cache'; site=self.root/'site-cache'; explicit=self.root/'explicit-cache'
        self.write(self.roaming/'pip'/'pip.ini',f'[global]\ncache-dir={user}\n')
        self.env['VIRTUAL_ENV']=str(self.root/'venv')
        self.write(Path(self.env['VIRTUAL_ENV'])/'pip.ini',f'[global]\ncache-dir={site}\n')
        p=self.write(self.root/'pip-explicit.ini',f'[global]\ncache-dir={explicit}\n')
        self.env['PIP_CONFIG_FILE']=str(p)
        self.assertEqual(self.discover()['pip']['path'],str(explicit))
        self.env['PIP_CONFIG_FILE']=os.devnull
        item=self.discover()['pip']; self.assertEqual(item['source'],'default'); self.assertEqual(item['path'],str(self.local/'pip'/'Cache'))

    def test_uv_top_level_setting_only_and_pnpm_current_global_config(self):
        uv=self.root/'uv custom'; pnpm=self.root/'pnpm custom'
        self.write(self.roaming/'uv'/'uv.toml',f"cache-dir = '{uv}'\n[index]\ncache-dir = 'not-cache'\n")
        self.write(self.local/'pnpm'/'config'/'config.yaml',f"storeDir: '{pnpm}'\n")
        items=self.discover()
        self.assertEqual(items['uv']['path'],str(uv)); self.assertEqual(items['pnpm-store']['path'],str(pnpm))
        self.assertIn('gradle',items); self.assertIn('maven',items)
        self.assertTrue(items['maven']['protected'])

    def test_cache_coverage_is_local_not_entire_scan(self):
        location=self.local/'npm-cache'; location.mkdir(parents=True)
        self.scan['directories']=[{'id':'n','path':str(location),'bytes':17,'coverage':{'status':'complete','errors':0,'skipped':0}}]
        item=self.discover()['npm']; self.assertEqual(item['bytes'],17)
        self.assertFalse(item['sizeIsPartial']); self.assertEqual(item['coverage']['status'],'complete')

    def test_unknown_coverage_and_missing_path_are_not_complete_zero(self):
        items=self.discover(); item=items['npm']
        self.assertIsNone(item['bytes']); self.assertFalse(item['exists']); self.assertTrue(item['sizeIsPartial'])
        location=self.local/'npm-cache'; location.mkdir(parents=True)
        self.scan['directories']=[{'id':'n','path':str(location),'bytes':8}]
        self.assertEqual(self.discover()['npm']['coverage']['status'],'unknown')

    def test_relative_remote_unresolved_and_special_paths_are_not_probed(self):
        for path in ['relative/cache',r'\\server\share\cache','${MISSING}/cache','-0']:
            self.env['NPM_CONFIG_CACHE']=path
            item=self.discover()['npm']
            self.assertTrue(item['protected']); self.assertIsNone(item['exists']); self.assertIsNone(item['bytes'])
            self.assertEqual(item['evidenceStatus'],'unverified')

    def test_unsafe_or_oversized_configuration_is_not_read(self):
        big=self.write(self.home/'.npmrc','cache='+('x'*1048576))
        value=read_setting(big,'cache'); self.assertTrue(value['uncertain']); self.assertIsNone(value['value'])
        big.unlink()
        target=self.write(self.root/'outside.txt','cache=ignored')
        try: os.symlink(target,big)
        except OSError: return
        value=read_setting(big,'cache'); self.assertTrue(value['uncertain']); self.assertIsNone(value['value'])


if __name__=='__main__': unittest.main()
