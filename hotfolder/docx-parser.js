const mammoth = require('mammoth');

const META_LABELS = ['effective date', 'authored by', 'revised by', 'reviewed by', 'approved by'];
const LABEL_RE    = new RegExp(`^(${META_LABELS.join('|')})\\s*:?\\s*(.*)$`, 'i');
// Matches "CMP-01-002 - Title", "CL001 – Title", "HR-001, Title" etc.
const POLREF_RE   = /^([A-Z]{2,}[0-9\-][A-Z0-9\-]*)\s*[-–,]\s*(.+)$/i;

async function parseDocx(filePath) {
  const { value: html } = await mammoth.convertToHtml({ path: filePath });

  // Collect leading tables that form the banner (title/dept + metadata).
  // Stop once we've consumed the table containing metadata labels.
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let m;
  let bannerEndIndex = 0;
  let bannerText     = '';
  let metaFound      = false;

  while ((m = tableRe.exec(html)) !== null) {
    if (metaFound) break;                                  // already got metadata
    if (m.index > 3000 && !bannerText) break;             // too deep, no banner started

    const text = blockText(m[0]);
    const hasMeta = META_LABELS.some(l => text.toLowerCase().includes(l));

    // Accept table if it's the first one or immediately follows the previous banner table
    const adjacent = m.index <= bannerEndIndex + 400;
    if (!hasMeta && !adjacent && bannerText) break;       // gap — we've passed the banner

    bannerText    += '\n' + text;
    bannerEndIndex = m.index + m[0].length;
    if (hasMeta) metaFound = true;
  }

  const metadata = parseBannerText(bannerText);

  // Strip leading empty paragraphs from body
  let content = html.slice(bannerEndIndex).replace(/^(\s*<p[^>]*>\s*<\/p>\s*)*/i, '').trim();

  // Fallback: if no title extracted from tables, check the first paragraph/heading
  // for a policy-ref pattern (e.g. "CMP-01-002 - Title" or "CMP-01-002, Title")
  if (!metadata.title) {
    const firstBlockRe = /<(p|h[1-6])[^>]*>([\s\S]*?)<\/\1>/i;
    const fb = firstBlockRe.exec(content);
    if (fb) {
      const text = blockText(fb[0]).trim();
      const polMatch = text.match(POLREF_RE);
      if (polMatch) {
        metadata.policyno = polMatch[1].trim();
        metadata.title    = polMatch[2].trim();
        // Strip this element from content since it's now in metadata
        content = content.slice(fb.index + fb[0].length)
          .replace(/^(\s*<p[^>]*>\s*<\/p>\s*)*/i, '').trim();
      }
    }
  }

  return { ...metadata, content };
}

// ── Banner parser ─────────────────────────────────────────────────────────────

function parseBannerText(text) {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);

  let department = '';
  let policyno   = '';
  let title      = '';
  const found    = {};
  let i = 0;

  // Header lines: non-label lines at the start = dept (line 0), policy ref (line 1)
  while (i < lines.length && !LABEL_RE.test(lines[i])) {
    if (!department) {
      department = lines[i];
    } else if (!title) {
      const ref = lines[i];
      const polMatch = ref.match(POLREF_RE);
      if (polMatch) {
        policyno = polMatch[1].trim();
        title    = polMatch[2].trim();
      } else {
        title = ref;
      }
    }
    i++;
  }

  // Label / value pairs
  while (i < lines.length) {
    const lm = lines[i].match(LABEL_RE);
    if (lm) {
      const key = lm[1].toLowerCase().replace(/\s+/g, ' ');
      let val   = lm[2].trim();
      // Value may be on the next line if cell was in a separate <td>
      if (!val && i + 1 < lines.length && !LABEL_RE.test(lines[i + 1])) {
        val = lines[++i].trim();
      }
      found[key] = val;
    }
    i++;
  }

  const approvedRaw = found['approved by'] || '';
  const revisedRaw  = found['revised by']  || '';
  const authoredRaw = found['authored by'] || '';

  const { name: approvedBy, date: approvedDate } = parseNameDate(approvedRaw);
  const { name: owner }                           = parseNameDate(revisedRaw || authoredRaw);
  const effectiveDate = found['effective date'] || '';

  return { title, policyno, department, effectiveDate, approvedBy, approvedDate, owner };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function blockText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|td|th|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function parseNameDate(raw) {
  if (!raw) return { name: '', date: '' };
  const m = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  return m ? { name: m[1].trim(), date: m[2].trim() } : { name: raw.trim(), date: '' };
}

module.exports = { parseDocx };
