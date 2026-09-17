import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFiles, parsePlan, renderInline, renderMarkdown, safeUrl } from '../scripts/report/markdown.mjs';

const html = (md) => renderMarkdown(md).html;

test('raw HTML is always escaped', () => {
  const out = html(`<script>alert(1)</script> <img src=x onerror=alert(1)> <Tags>`);
  assert.ok(!/<script|<img|<Tags/i.test(out), out);
  assert.match(out, /&lt;script&gt;/);
});

test('code spans and fences keep their content literal', () => {
  assert.equal(renderInline('use `<b>**x**</b>` here'), 'use <code>&lt;b&gt;**x**&lt;/b&gt;</code> here');
  assert.equal(html('```\n<b>**x**</b>\n```'), '<pre><code>&lt;b&gt;**x**&lt;/b&gt;</code></pre>');
});

test('links pass a scheme allowlist', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl(' JaVaScRiPt:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,x'), null);
  assert.equal(safeUrl('https://example.com'), 'https://example.com');
  assert.ok(!renderInline('[x](javascript:alert(1))').includes('<a'));
  assert.match(renderInline('[docs](https://example.com/a?b=1&c=2)'), /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
});

test('an attribute cannot be broken out of', () => {
  const out = renderInline('[x](https://example.com/"onmouseover="alert(1))');
  assert.ok(!out.includes('"onmouseover'), out);
});

test('bare URLs autolink and shed trailing punctuation', () => {
  assert.equal(
    renderInline('see https://example.com/path.'),
    'see <a href="https://example.com/path" target="_blank" rel="noopener noreferrer">https://example.com/path</a>.',
  );
});

test('emphasis, and snake_case is left alone', () => {
  assert.equal(renderInline('**bold** and *em* and price_per_trip * 100'), '<strong>bold</strong> and <em>em</em> and price_per_trip * 100');
});

test('lists nest, keep their start number, and render checkboxes', () => {
  assert.equal(html('1. one\n2. two\n   - inner\n   - more\n3. three'), '<ol><li>one</li><li>two<ul><li>inner</li><li>more</li></ul></li><li>three</li></ol>');
  assert.match(html('3. three\n4. four'), /^<ol start="3">/);
  assert.match(html('- [ ] todo\n- [x] done'), /data-done="false".*data-done="true"/);
});

test('tables, quotes, rules, headings', () => {
  assert.match(html('| a | b |\n|---|---|\n| 1 | **2** |'), /<th>a<\/th><th>b<\/th>.*<td>1<\/td><td><strong>2<\/strong><\/td>/);
  assert.equal(html('> quoted *text*'), '<blockquote><p>quoted <em>text</em></p></blockquote>');
  assert.equal(html('---'), '<hr>');
  assert.equal(html('# Title'), '<h3>Title</h3>');
});

test('oversized input is truncated on a line boundary', () => {
  const out = renderMarkdown('line one\nline two\nline three', { maxBytes: 12 });
  assert.equal(out.truncated, true);
  assert.equal(out.html, '<p>line one</p>');
});

test('pathological input stays fast', () => {
  const start = Date.now();
  renderMarkdown(`${'*'.repeat(20000)}\n${'['.repeat(20000)}\n${'> '.repeat(5000)}x\n${'`'.repeat(20001)}`);
  assert.ok(Date.now() - start < 1500, `took ${Date.now() - start}ms`);
});

test('plan files split into sections; the header is parsed but never trusted', () => {
  const plan = parsePlan('# Fix the shelf\n\n**Task:** https://x\n**Area:** storefront | **Type:** bug\n\n## What Needs to Change\n\nText.\n\n## Files Involved\n\n- `a/b.ts`\n- `c/d.ts` — the test\n\n```\n## not a heading\n```\n\n## Open Question\n\nWhich one?\n');
  assert.equal(plan.title, 'Fix the shelf');
  assert.deepEqual(plan.header, { task: 'https://x', area: 'storefront', type: 'bug' });
  assert.deepEqual(plan.sections.map((s) => s.slug), ['what-needs-to-change', 'files-involved', 'open-question']);
  assert.deepEqual(extractFiles(plan.sections[1].markdown), [{ path: 'a/b.ts', note: '' }, { path: 'c/d.ts', note: 'the test' }]);
  assert.equal(plan.sections[2].markdown, 'Which one?');
});
