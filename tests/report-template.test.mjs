import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('standalone template runs its inline app only after the root and data slot exist',async()=>{
  const html=await fs.readFile(new URL('../report-assets/template.html',import.meta.url),'utf8');
  const root=html.indexOf('<div id="root">'),data=html.indexOf('<!--LIUBAI_REPORT_DATA-->'),script=html.indexOf('<script>');
  assert.ok(root>=0&&data>root&&script>data,'Classic inline entry must follow the DOM root and embedded snapshot');
  assert.equal(/<script[^>]+src=/.test(html),false);
  assert.equal(/<link[^>]+rel="stylesheet"/.test(html),false);
  assert.ok(html.includes("connect-src 'none'"));
  const licenses=html.match(/<pre hidden id="liubai-licenses">([\s\S]*?)<\/pre>/)?.[1]||'';
  assert.match(licenses,/scheduler\s+MIT License/,'Bundled scheduler attribution must be present in the standalone artifact');
});
