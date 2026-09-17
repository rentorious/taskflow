// Markdown for the report: a plan-file section parser and a small renderer.
//
// The text comes from provider tickets and model output, so the renderer is
// escape-first: every character is HTML-escaped before any markup is added, and
// the only tags that can appear are the ones emitted here. Link targets pass a
// scheme allowlist. All patterns are linear-time (no nested quantifiers).

const DEFAULT_MAX_BYTES = 512 * 1024;
const SAFE_SCHEMES = /^(https?:|mailto:)/i;

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Returns the URL when its scheme is allowed, otherwise null. */
export function safeUrl(url) {
  const text = String(url ?? '').trim();
  return SAFE_SCHEMES.test(text) ? text : null;
}

export function slugify(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

// One alternation, one pass: a match is never re-scanned, so a link's text
// cannot be re-interpreted as a bare URL.
// Every repetition is bounded: an unclosed "[" or "*" on a very long line would
// otherwise rescan to the end of the line from each position (quadratic).
const INLINE = /\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)|\*\*([^*\n]{1,2000})\*\*|\*([^*\s][^*\n]{0,2000})\*|(https?:\/\/[^\s<>()[\]]{1,2000})/g;

function link(href, labelHtml) {
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
}

function renderEscapedInline(escaped) {
  return escaped.replace(INLINE, (whole, label, target, bold, italic, bare) => {
    if (label !== undefined) {
      // `target` is already escaped, so it is attribute-safe once the scheme passes.
      return safeUrl(target) ? link(target, renderEscapedInline(label)) : whole;
    }
    if (bold !== undefined) return `<strong>${renderEscapedInline(bold)}</strong>`;
    if (italic !== undefined) return `<em>${renderEscapedInline(italic)}</em>`;
    const trimmed = bare.replace(/[.,;:!?]+$/, '');
    return link(trimmed, trimmed) + bare.slice(trimmed.length);
  });
}

/** Render one line of inline markdown. Code spans are split out first. */
export function renderInline(text) {
  const source = String(text ?? '');
  let html = '';
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('`', cursor);
    const close = open === -1 ? -1 : source.indexOf('`', open + 1);
    if (open === -1 || close === -1) break;
    html += renderEscapedInline(escapeHtml(source.slice(cursor, open)));
    html += `<code>${escapeHtml(source.slice(open + 1, close))}</code>`;
    cursor = close + 1;
  }
  return html + renderEscapedInline(escapeHtml(source.slice(cursor)));
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const CHECKBOX = /^\[([ xX])\]\s+/;

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function renderTable(head, rows) {
  const th = splitRow(head).map((c) => `<th>${renderInline(c)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${splitRow(r).map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderItem(text) {
  const box = CHECKBOX.exec(text);
  if (!box) return renderInline(text);
  const done = box[1] !== ' ';
  return `<span class="md-check" data-done="${done}" aria-hidden="true"></span>${renderInline(text.slice(box[0].length))}`;
}

function renderList(items) {
  let html = '';
  const stack = [];
  for (const item of items) {
    while (stack.length && item.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    if (!stack.length || item.indent > stack[stack.length - 1].indent) {
      const tag = item.ordered ? 'ol' : 'ul';
      const start = item.ordered && item.number !== 1 ? ` start="${item.number}"` : '';
      stack.push({ indent: item.indent, tag });
      html += `<${tag}${start}>`;
    } else {
      html += '</li>';
    }
    html += `<li>${renderItem(item.text)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

function renderBlocks(lines, depth) {
  let html = '';
  let i = 0;
  const isBlank = (line) => line === undefined || line.trim() === '';

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      html += `<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // Plan files start at "#"; the page already owns h1/h2.
      const level = Math.min(6, heading[1].length + 2);
      html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
      i++;
      continue;
    }

    if (RULE.test(line)) { html += '<hr>'; i++; continue; }

    if (line.trimStart().startsWith('>')) {
      const quoted = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        quoted.push(lines[i].trimStart().replace(/^>\s?/, ''));
        i++;
      }
      // Depth-capped so "> > > ..." input cannot recurse without bound.
      html += `<blockquote>${depth < 4 ? renderBlocks(quoted, depth + 1) : escapeHtml(quoted.join(' '))}</blockquote>`;
      continue;
    }

    if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const rows = [];
      let j = i + 2;
      while (j < lines.length && !isBlank(lines[j]) && lines[j].includes('|')) rows.push(lines[j++]);
      html += renderTable(line, rows);
      i = j;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m) {
          const ordered = /\d/.test(m[2]);
          items.push({ indent: m[1].length, ordered, number: ordered ? parseInt(m[2], 10) : null, text: m[3] });
          i++;
        } else if (!isBlank(lines[i]) && /^\s+/.test(lines[i])) {
          items[items.length - 1].text += ' ' + lines[i].trim();
          i++;
        } else if (isBlank(lines[i]) && LIST_ITEM.test(lines[i + 1] ?? '')) {
          i++;
        } else {
          break;
        }
      }
      html += renderList(items);
      continue;
    }

    const para = [];
    while (
      i < lines.length && !isBlank(lines[i]) && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) && !lines[i].trimStart().startsWith('>') && !RULE.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    html += `<p>${renderInline(para.join(' '))}</p>`;
  }
  return html;
}

/**
 * @param {string} markdown
 * @param {{maxBytes?: number}} [options]
 * @returns {{html: string, truncated: boolean}}
 */
export function renderMarkdown(markdown, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let source = String(markdown ?? '').replace(/\r\n?/g, '\n');
  let truncated = false;
  if (source.length > maxBytes) {
    const cut = source.lastIndexOf('\n', maxBytes);
    source = source.slice(0, cut > 0 ? cut : maxBytes);
    truncated = true;
  }
  return { html: renderBlocks(source.split('\n'), 0), truncated };
}

// ---------------------------------------------------------------------------
// Plan files
// ---------------------------------------------------------------------------

/**
 * Split a plan file into its "## " sections. The "**Key:** value" header block
 * is returned for completeness only: it goes stale (triage rewrites the index,
 * not the plan), so callers must never read pipeline state from it.
 */
export function parsePlan(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const plan = { title: null, header: {}, sections: [] };
  let current = null;
  let fenced = false;

  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    const section = !fenced && /^##\s+(.+?)\s*$/.exec(line);
    if (section) {
      current = { title: section[1], slug: slugify(section[1]), lines: [] };
      plan.sections.push(current);
      continue;
    }
    if (current) { current.lines.push(line); continue; }

    const title = /^#\s+(.+?)\s*$/.exec(line);
    if (title && plan.title === null) { plan.title = title[1]; continue; }
    for (const part of line.split(' | ')) {
      const field = /^\*\*([^*:]+):\*\*\s*(.*)$/.exec(part.trim());
      if (field) plan.header[slugify(field[1])] = field[2].trim();
    }
  }

  plan.sections = plan.sections.map((s) => ({ title: s.title, slug: s.slug, markdown: s.lines.join('\n').trim() }));
  return plan;
}

/** Bulleted, backticked paths from a "Files Involved" section. */
export function extractFiles(sectionMarkdown) {
  const files = [];
  for (const line of String(sectionMarkdown ?? '').split('\n')) {
    const m = /^\s*[-*+]\s+`([^`]+)`\s*(?:[-–—:]\s*)?(.*)$/.exec(line);
    if (m) files.push({ path: m[1], note: m[2].trim() });
  }
  return files;
}
