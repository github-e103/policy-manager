const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { diffWords, diffArrays } = require('diff');
const { db } = require('../database/db');

const TEMPLATE_PATH  = path.join(__dirname, '..', 'templates', 'policy-pdf.html');
// Base URL so Puppeteer resolves relative asset paths (imgs/, fonts/, etc.) from the frontend folder
const FRONTEND_BASE  = 'file:///' + path.join(__dirname, '..', 'frontend').replace(/\\/g, '/') + '/';

function policyFilename(policyNo, title) {
  const safeNo    = (policyNo || 'POL').replace(/[^a-z0-9\-_.]/gi, '_');
  const safeTitle = (title    || 'Untitled').replace(/[^a-z0-9\-_. ]/gi, '_').slice(0, 30).trimEnd();
  return `${safeNo}-${safeTitle}.pdf`;
}

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
];

async function launchBrowser() {
  const puppeteer = require('puppeteer');
  return puppeteer.launch({ headless: true, args: CHROME_ARGS });
}

// Persistent browser reused for single-page operations (preview, single export).
let _browser;
async function getBrowser() {
  if (!_browser || !_browser.isConnected()) {
    _browser = null;
    _browser = await launchBrowser();
    _browser.on('disconnected', () => { _browser = null; });
  }
  return _browser;
}

function makePdfOptions(policyNo, title) {
  const label = esc(policyNo ? `${policyNo} — ${title}` : title);
  return {
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', right: '0mm', bottom: '14mm', left: '0mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div style="height:450px;"></div>',
    footerTemplate: `<div style="width:100%;font-size:8pt;color:#929292;padding:0 20mm;
      display:flex;justify-content:space-between;font-family:'Aptos',Arial,sans-serif;box-sizing:border-box;">
      <span>${label}</span>
      <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>`
  };
}

const MIME_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

function inlineImages(html) {
  return html.replace(/(<img\b[^>]*\ssrc=")([^"]+)(")/gi, (match, pre, src, post) => {
    if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) return match;
    const absPath = path.resolve(FRONTEND_DIR, src.replace(/^\//, ''));
    try {
      const ext = path.extname(absPath).slice(1).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const data = fs.readFileSync(absPath).toString('base64');
      return `${pre}data:${mime};base64,${data}${post}`;
    } catch {
      return match;
    }
  });
}

function fillTemplate(policy, version, metadata) {
  const fmt = d => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const polId = policy.policy_no || '';

  const rendered = fs.readFileSync(TEMPLATE_PATH, 'utf8')
    .replace(/\{\{POLICY_NO\}\}/g,          polId)
    .replace(/\{\{VERSION_NUMBER\}\}/g,    String(version.version_number))
    .replace(/\{\{GENERATED_DATE\}\}/g,    fmt(new Date()))
    .replace(/\{\{TITLE\}\}/g,             esc(policy.title))
    .replace(/\{\{CREATED_DATE\}\}/g,      fmt(policy.created_at))
    .replace(/\{\{UPDATED_DATE\}\}/g,      fmt(policy.updated_at))
    .replace(/\{\{OWNER\}\}/g,             esc(metadata.owner  || policy.owner))
    .replace(/\{\{DEPARTMENT\}\}/g,        esc(metadata.department || policy.department))
    .replace(/\{\{CATEGORY\}\}/g,          esc(metadata.category   || policy.category))
    .replace(/\{\{STATUS\}\}/g,            policy.status)
    .replace(/\{\{STATUS_CLASS\}\}/g,      `s-${policy.status}`)
    .replace(/\{\{CREATED_BY\}\}/g,        esc(version.created_by))
    .replace(/\{\{APPROVED_BY\}\}/g,       esc(policy.approved_by || '—'))
    .replace(/\{\{APPROVED_DATE\}\}/g,     policy.approved_at ? fmt(policy.approved_at) : '—')
    .replace(/\{\{BODY_HTML\}\}/g,         version.body_html || '<p><em>No content provided.</em></p>');

  return inlineImages(rendered);
}

// POST /api/policies/preview-pdf — live preview: returns PDF bytes for the current form state
router.post('/preview-pdf', async (req, res) => {
  const {
    title = '', owner = '', department = '', category = '', policy_no = '',
    status = 'draft', body_html = '', version_number = 1, created_by = 'System'
  } = req.body;

  const now = new Date().toISOString();
  const policy  = { id: 0, title, owner, department, category, status, policy_no, created_at: now, updated_at: now };
  const version = { version_number, body_html, created_by, change_summary: '' };
  const html = fillTemplate(policy, version, { title, owner, department, category });

  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', baseURL: FRONTEND_BASE });
      const pdf = await page.pdf(makePdfOptions(policy_no, title));
      res.type('application/pdf').send(Buffer.from(pdf));
    } finally {
      await page.close();
    }
  } catch (err) {
    console.error('Preview PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/policies — list all with latest version info
router.get('/', (req, res) => {
  try {
    const policies = db.all(`
      SELECT
        p.*,
        pv.version_number,
        pv.change_summary,
        pub.version_number AS published_version_number
      FROM policies p
      LEFT JOIN policy_versions pv ON pv.id = (
        SELECT id FROM policy_versions
        WHERE policy_id = p.id
        ORDER BY version_number DESC
        LIMIT 1
      )
      LEFT JOIN policy_versions pub ON pub.id = p.published_version_id
      ORDER BY p.updated_at DESC
    `);
    res.json(policies);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

function sessionTitle(req) {
  if (!req.session?.user) return null;
  const u = db.get('SELECT title FROM users WHERE id = ?', [req.session.user.id]);
  return u?.title?.trim() || req.session.user.displayName || req.session.user.username || null;
}

// POST /api/policies — create new policy
router.post('/', (req, res) => {
  const {
    title, owner, department, category,
    body_html = '', change_summary = 'Initial version',
  } = req.body;
  const created_by = sessionTitle(req) || req.body.created_by || 'System';

  if (!title || !owner || !department || !category) {
    return res.status(400).json({ error: 'title, owner, department, and category are required' });
  }

  try {
    const record = db.transaction(tx => {
      const pol = tx.run(
        `INSERT INTO policies (title, owner, department, category, status) VALUES (?, ?, ?, ?, 'draft')`,
        [title, owner, department, category]
      );
      const policyId = pol.lastInsertRowid;
      const metadata = JSON.stringify({ title, owner, department, category });

      const ver = tx.run(
        `INSERT INTO policy_versions (policy_id, version_number, metadata_json, body_html, change_summary, created_by) VALUES (?, 1, ?, ?, ?, ?)`,
        [policyId, metadata, body_html, change_summary, created_by]
      );

      tx.run(
        `INSERT INTO policy_workflow (policy_version_id, stage, actor, comments) VALUES (?, 'draft', ?, 'Policy created')`,
        [ver.lastInsertRowid, created_by]
      );

      return tx.get('SELECT * FROM policies WHERE id = ?', [policyId]);
    });

    res.status(201).json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/policies/:id/diff?from=N&to=M — word-level redline diff between two versions
router.get('/:id/diff', (req, res) => {
  const { id } = req.params;
  const fromVer = parseInt(req.query.from);
  const toVer   = parseInt(req.query.to);

  if (isNaN(fromVer) || isNaN(toVer)) {
    return res.status(400).json({ error: 'from and to version numbers are required' });
  }

  try {
    const v1 = db.get(
      `SELECT * FROM policy_versions WHERE policy_id = ? AND version_number = ?`, [id, fromVer]
    );
    const v2 = db.get(
      `SELECT * FROM policy_versions WHERE policy_id = ? AND version_number = ?`, [id, toVer]
    );
    if (!v1 || !v2) return res.status(404).json({ error: 'Version not found' });

    const stripTags = html => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    const parts = diffWords(stripTags(v1.body_html), stripTags(v2.body_html));
    const diffHtml = parts.map(p => {
      if (p.added)   return `<ins>${esc(p.value)}</ins>`;
      if (p.removed) return `<del>${esc(p.value)}</del>`;
      return esc(p.value);
    }).join('');

    res.json({
      from: { version_number: v1.version_number, created_at: v1.created_at, created_by: v1.created_by, change_summary: v1.change_summary },
      to:   { version_number: v2.version_number, created_at: v2.created_at, created_by: v2.created_by, change_summary: v2.change_summary },
      diffHtml,
      unchanged: parts.every(p => !p.added && !p.removed)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/policies/:id/versions — must be before /:id
router.get('/:id/versions', (req, res) => {
  const { id } = req.params;
  try {
    if (!db.get('SELECT id FROM policies WHERE id = ?', [id])) {
      return res.status(404).json({ error: 'Policy not found' });
    }
    const versions = db.all(
      `SELECT * FROM policy_versions WHERE policy_id = ? ORDER BY version_number DESC`,
      [id]
    );
    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/policies/:id/workflow — must be before /:id
router.post('/:id/workflow', (req, res) => {
  const { id } = req.params;
  const { stage, comments = '' } = req.body;
  const actor = sessionTitle(req) || req.body.actor || 'System';

  const validStages = ['draft', 'review', 'approved', 'rejected'];
  if (!stage || !validStages.includes(stage)) {
    return res.status(400).json({ error: `stage must be one of: ${validStages.join(', ')}` });
  }

  if (['approved', 'rejected'].includes(stage)) {
    const role = req.session?.user?.role;
    if (!['admin', 'approver'].includes(role)) {
      return res.status(403).json({ error: 'Only approvers can approve or reject policies' });
    }
  }

  try {
    const policy = db.get('SELECT * FROM policies WHERE id = ?', [id]);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    const latestVersion = db.get(
      `SELECT * FROM policy_versions WHERE policy_id = ? ORDER BY version_number DESC LIMIT 1`,
      [id]
    );
    if (!latestVersion) return res.status(400).json({ error: 'No version found for this policy' });

    const updated = db.transaction(tx => {
      tx.run(
        `INSERT INTO policy_workflow (policy_version_id, stage, actor, comments) VALUES (?, ?, ?, ?)`,
        [latestVersion.id, stage, actor, comments]
      );

      if (stage === 'approved') {
        tx.run(
          `UPDATE policies SET status='approved', published_version_id=?, approved_by=?, approved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
          [latestVersion.id, actor, id]
        );
      } else if (stage === 'draft' && policy.published_version_id) {
        // Re-opening an approved policy: fork a new draft version so the approved
        // snapshot stays frozen in history and future saves overwrite the new row.
        const nextVer = (latestVersion.version_number || 0) + 1;
        tx.run(
          `INSERT INTO policy_versions (policy_id, version_number, metadata_json, body_html, change_summary, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, nextVer, latestVersion.metadata_json, latestVersion.body_html, '', actor]
        );
        tx.run(
          `UPDATE policies SET status='draft', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [id]
        );
      } else {
        tx.run(
          `UPDATE policies SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
          [stage, id]
        );
      }

      return tx.get('SELECT * FROM policies WHERE id = ?', [id]);
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/policies/:id/lock — acquire or heartbeat-refresh an edit lock
router.post('/:id/lock', (req, res) => {
  const { id } = req.params;
  const { session_id, display_name = 'Someone' } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  const policy = db.get('SELECT * FROM policies WHERE id = ?', [id]);
  if (!policy) return res.status(404).json({ error: 'Policy not found' });

  const LOCK_TTL_MS = 15 * 60 * 1000;

  if (policy.locked_by) {
    const [lockedSession, lockedName] = policy.locked_by.split('|');
    if (lockedSession !== session_id) {
      const age = Date.now() - new Date(policy.locked_at).getTime();
      if (age < LOCK_TTL_MS) {
        return res.status(409).json({
          error: 'locked',
          locked_by_name: lockedName || 'Someone',
          locked_at: policy.locked_at,
        });
      }
    }
  }

  db.run(`UPDATE policies SET locked_by=?, locked_at=CURRENT_TIMESTAMP WHERE id=?`,
    [`${session_id}|${display_name}`, id]);
  res.json({ acquired: true });
});

// POST /api/policies/:id/unlock — release an edit lock
router.post('/:id/unlock', (req, res) => {
  const { id } = req.params;
  const { session_id } = req.body;

  const policy = db.get('SELECT * FROM policies WHERE id = ?', [id]);
  if (!policy) return res.status(404).json({ error: 'Policy not found' });

  if (policy.locked_by && policy.locked_by.startsWith(session_id + '|')) {
    db.run(`UPDATE policies SET locked_by=NULL, locked_at=NULL WHERE id=?`, [id]);
  }
  res.json({ success: true });
});

// GET /api/policies/:id/preview — rendered HTML preview (open in browser)
router.get('/:id/preview', (req, res) => {
  const { id } = req.params;
  try {
    const policy = db.get('SELECT * FROM policies WHERE id = ?', [id]);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    const latestVersion = db.get(
      `SELECT * FROM policy_versions WHERE policy_id = ? ORDER BY version_number DESC LIMIT 1`,
      [id]
    );
    if (!latestVersion) return res.status(400).json({ error: 'No version found' });

    const metadata = JSON.parse(latestVersion.metadata_json || '{}');
    res.type('html').send(fillTemplate(policy, latestVersion, metadata));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/policies/:id/export-pdf
// Optional body: { version_id }  — export a specific version row by its DB id
// Optional query: ?published=true — export the last approved version
router.post('/:id/export-pdf', async (req, res) => {
  const { id } = req.params;
  const usePublished = req.query.published === 'true';
  const { version_id } = req.body || {};

  try {
    const policy = db.get('SELECT * FROM policies WHERE id = ?', [id]);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    let targetVersion;
    if (version_id) {
      targetVersion = db.get(`SELECT * FROM policy_versions WHERE id = ? AND policy_id = ?`, [version_id, id]);
    } else if (usePublished && policy.published_version_id) {
      targetVersion = db.get(`SELECT * FROM policy_versions WHERE id = ?`, [policy.published_version_id]);
    } else {
      targetVersion = db.get(`SELECT * FROM policy_versions WHERE policy_id = ? ORDER BY version_number DESC LIMIT 1`, [id]);
    }
    const latestVersion = targetVersion;
    if (!latestVersion) return res.status(400).json({ error: 'No version found' });

    // When exporting the published snapshot, always show "approved" status in the PDF
    const isPublishedExport = !version_id && usePublished && policy.published_version_id;
    const isSpecificVersion  = !!version_id && version_id == policy.published_version_id;
    const policyForTemplate  = (isPublishedExport || isSpecificVersion)
      ? { ...policy, status: 'approved' }
      : policy;

    const metadata = JSON.parse(latestVersion.metadata_json || '{}');
    const html = fillTemplate(policyForTemplate, latestVersion, metadata);

    const exportsDir = path.join(__dirname, '..', 'exports');
    fs.mkdirSync(exportsDir, { recursive: true });

    const filename = policyFilename(policy.policy_no, policy.title);
    const filepath = path.join(exportsDir, filename);

    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', baseURL: FRONTEND_BASE });
      await page.pdf({ ...makePdfOptions(policy.policy_no, policy.title), path: filepath });
    } finally {
      await page.close();
    }

    res.json({ filename, downloadUrl: `/exports/${filename}`, message: 'PDF generated' });
  } catch (err) {
    console.error('PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/policies/:id/export-redline-pdf?from=N&to=M
router.get('/:id/export-redline-pdf', async (req, res) => {
  const { id } = req.params;
  const fromVer = parseInt(req.query.from);
  const toVer   = parseInt(req.query.to);

  if (isNaN(fromVer) || isNaN(toVer)) {
    return res.status(400).json({ error: 'from and to version numbers are required' });
  }

  try {
    const policy = db.get('SELECT * FROM policies WHERE id = ?', [id]);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    const v1 = db.get(`SELECT * FROM policy_versions WHERE policy_id = ? AND version_number = ?`, [id, fromVer]);
    const v2 = db.get(`SELECT * FROM policy_versions WHERE policy_id = ? AND version_number = ?`, [id, toVer]);
    if (!v1 || !v2) return res.status(404).json({ error: 'Version not found' });

    const diffHtml = buildRedlineHtml(v1.body_html, v2.body_html);
    const metadata = JSON.parse(v2.metadata_json || '{}');
    const syntheticVersion = {
      version_number: `${fromVer} → ${toVer}`,
      body_html:      diffHtml || '<p><em>No text changes between these versions.</em></p>',
      created_by:     v2.created_by || 'System',
      change_summary: `Redline comparison: v${fromVer} → v${toVer}`,
    };

    const html = fillTemplate(policy, syntheticVersion, metadata);

    const exportsDir = path.join(__dirname, '..', 'exports');
    fs.mkdirSync(exportsDir, { recursive: true });
    const filename = `redline-${id}-v${fromVer}-v${toVer}-${Date.now()}.pdf`;
    const filepath = path.join(exportsDir, filename);

    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', baseURL: FRONTEND_BASE });
      await page.pdf({ ...makePdfOptions(policy.policy_no, policy.title), path: filepath });
    } finally {
      await page.close();
    }

    res.json({ filename, downloadUrl: `/exports/${filename}` });
  } catch (err) {
    console.error('Redline PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/policies/batch-export — download selected policies as a ZIP of PDFs
// Body: { ids: [1, 2, 3, ...] }
router.post('/batch-export', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids array is required' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="policies-export-${Date.now()}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { console.error('Archive error:', err); res.end(); });
  archive.pipe(res);

  const browser = await launchBrowser();

  for (const id of ids) {
    try {
      const policy = db.get('SELECT * FROM policies WHERE id = ?', [id]);
      if (!policy) continue;

      const version = db.get(
        `SELECT * FROM policy_versions WHERE policy_id = ? ORDER BY version_number DESC LIMIT 1`, [id]
      );
      if (!version) continue;

      const metadata = JSON.parse(version.metadata_json || '{}');
      const html = fillTemplate(policy, version, metadata);

      const page = await browser.newPage();
      let pdfBuf;
      try {
        await page.setContent(html, { waitUntil: 'domcontentloaded', baseURL: FRONTEND_BASE });
        pdfBuf = await page.pdf(makePdfOptions(policy.policy_no, policy.title));
      } finally {
        await page.close();
      }

      archive.append(Buffer.from(pdfBuf), { name: policyFilename(policy.policy_no, policy.title) });
    } catch (err) {
      console.error(`Batch export: skipped policy ${id}:`, err.message);
    }
  }

  await archive.finalize();
  await browser.close();
});

// DELETE /api/policies/:id
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  try {
    if (!db.get('SELECT id FROM policies WHERE id = ?', [id])) {
      return res.status(404).json({ error: 'Policy not found' });
    }
    db.run('DELETE FROM policies WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/policies/:id
router.get('/:id', (req, res) => {
  const { id } = req.params;
  try {
    const policy = db.get('SELECT * FROM policies WHERE id = ?', [id]);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    const latestVersion = db.get(
      `SELECT * FROM policy_versions WHERE policy_id = ? ORDER BY version_number DESC LIMIT 1`,
      [id]
    );

    const workflow = db.all(`
      SELECT pw.* FROM policy_workflow pw
      JOIN policy_versions pv ON pw.policy_version_id = pv.id
      WHERE pv.policy_id = ?
      ORDER BY pw.actioned_at DESC
      LIMIT 20
    `, [id]);

    res.json({ ...policy, latestVersion, workflow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/policies/:id — save edits
//   • First save after approved/rejected  → new version row, status reset to draft
//   • Save while already in draft/review  → overwrite current version row in place
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { title, owner, department, category, policy_no, body_html, change_summary } = req.body;
  const created_by = sessionTitle(req) || req.body.created_by || 'System';

  try {
    const policy = db.get('SELECT * FROM policies WHERE id = ?', [id]);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    const t = title      || policy.title;
    const o = owner      || policy.owner;
    const d = department || policy.department;
    const c = category   || policy.category;
    const metadata = JSON.stringify({ title: t, owner: o, department: d, category: c });

    const updated = db.transaction(tx => {
      const latestVer = tx.get(
        `SELECT * FROM policy_versions WHERE policy_id = ? ORDER BY version_number DESC LIMIT 1`, [id]
      );

      const savingOverPublished = policy.published_version_id &&
        latestVer && String(latestVer.id) === String(policy.published_version_id);

      if (['approved', 'rejected'].includes(policy.status) || savingOverPublished) {
        // Starting a new draft on top of a finalised version — increment version number
        const nextVer = (latestVer?.version_number || 0) + 1;
        tx.run(
          `INSERT INTO policy_versions (policy_id, version_number, metadata_json, body_html, change_summary, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, nextVer, metadata, body_html ?? '', change_summary || '', created_by]
        );
      } else {
        // Already a draft/review — overwrite in place, no new version row
        tx.run(
          `UPDATE policy_versions SET metadata_json=?, body_html=?, change_summary=?, created_by=? WHERE id=?`,
          [metadata, body_html ?? '', change_summary || latestVer?.change_summary || '', created_by, latestVer?.id]
        );
      }

      const pno = policy_no !== undefined ? policy_no : policy.policy_no;
      tx.run(
        `UPDATE policies SET title=?, owner=?, department=?, category=?, policy_no=?, status='draft', updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [t, o, d, c, pno || null, id]
      );
      return tx.get('SELECT * FROM policies WHERE id = ?', [id]);
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

function buildRedlineHtml(v1Html, v2Html) {
  // Split on closing block tags so each block element is one segment
  const SEP = '\x01';
  const toSegments = html =>
    (html || '').replace(/<\/(p|h[1-6]|ul|ol|blockquote|pre|table)>/gi, m => m + SEP)
      .split(SEP).map(s => s.trim()).filter(Boolean);

  const stripAll = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const getTag   = s => { const m = s.match(/^<([a-z0-9]+)/i); return m ? m[1] : 'p'; };

  const segs1 = toSegments(v1Html);
  const segs2 = toSegments(v2Html);
  const changes = diffArrays(segs1.map(stripAll), segs2.map(stripAll));

  let out = '';
  let i1 = 0, i2 = 0;

  for (let ci = 0; ci < changes.length; ci++) {
    const ch   = changes[ci];
    const next = changes[ci + 1];

    if (!ch.added && !ch.removed) {
      // Unchanged: output v2 block verbatim (preserves all HTML/styling)
      for (let k = 0; k < ch.count; k++) { out += segs2[i2++]; i1++; }
      continue;
    }

    if (ch.removed && next && next.added) {
      // Modified blocks: word-diff within each paired block
      const pairs = Math.min(ch.count, next.count);
      for (let k = 0; k < pairs; k++) {
        const t1  = stripAll(segs1[i1++]);
        const tag = getTag(segs2[i2]);
        const t2  = stripAll(segs2[i2++]);
        const inner = diffWords(t1, t2).map(p => {
          if (p.added)   return `<ins>${esc(p.value)}</ins>`;
          if (p.removed) return `<del>${esc(p.value)}</del>`;
          return esc(p.value);
        }).join('');
        out += `<${tag}>${inner}</${tag}>`;
      }
      // Leftover pure removals
      for (let k = pairs; k < ch.count;   k++) out += `<p><del>${esc(stripAll(segs1[i1++]))}</del></p>`;
      // Leftover pure additions — output verbatim from v2
      for (let k = pairs; k < next.count; k++) out += segs2[i2++];
      ci++; // next already consumed
    } else if (ch.removed) {
      for (let k = 0; k < ch.count; k++) out += `<p><del>${esc(stripAll(segs1[i1++]))}</del></p>`;
    } else {
      // Pure additions — output verbatim from v2
      for (let k = 0; k < ch.count; k++) out += segs2[i2++];
    }
  }

  return out || v2Html;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
