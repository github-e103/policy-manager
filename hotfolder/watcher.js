const fs   = require('fs');
const path = require('path');
const { parseDocx } = require('./docx-parser');

const INBOX_DIR     = path.join(__dirname, 'inbox');
const PROCESSED_DIR = path.join(__dirname, 'processed');
const FAILED_DIR    = path.join(__dirname, 'failed');

[INBOX_DIR, PROCESSED_DIR, FAILED_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// Import a single policy object into the DB within an existing transaction.
// If a policy with the same policy_no already exists, add a new version instead.
function importOne(data, tx) {
  const {
    title         = '',
    policyno      = '',
    department    = '',
    effectiveDate = '',
    approvedDate  = '',
    approvedBy    = '',
    content       = '',
  } = data;

  if (!title.trim())      throw new Error('title is required');
  if (!department.trim()) throw new Error('department is required');

  const owner    = (approvedBy || 'System').trim();
  const category = 'Other';
  const metadata = JSON.stringify({ title, owner, department, category, policyno, effectiveDate, approvedDate, approvedBy });

  // Check for an existing policy with the same policy_no
  const existing = policyno
    ? tx.get('SELECT * FROM policies WHERE policy_no = ?', [policyno.trim()])
    : null;

  if (existing) {
    // Update metadata on the existing policy record, reset to draft
    tx.run(
      `UPDATE policies
          SET title=?, owner=?, department=?, approved_by=?, approved_at=?,
              status='draft', updated_at=CURRENT_TIMESTAMP
        WHERE id=?`,
      [title.trim(), owner, department.trim(),
       approvedBy || null, approvedDate || null,
       existing.id]
    );

    // Increment version number
    const latestVer = tx.get(
      `SELECT version_number FROM policy_versions WHERE policy_id = ? ORDER BY version_number DESC LIMIT 1`,
      [existing.id]
    );
    const nextVer = (latestVer?.version_number || 0) + 1;

    const ver = tx.run(
      `INSERT INTO policy_versions
         (policy_id, version_number, metadata_json, body_html, change_summary, created_by)
       VALUES (?, ?, ?, ?, 'Updated via hot folder', ?)`,
      [existing.id, nextVer, metadata, content, owner]
    );

    tx.run(
      `INSERT INTO policy_workflow (policy_version_id, stage, actor, comments)
       VALUES (?, 'draft', ?, 'Re-imported via hot folder')`,
      [ver.lastInsertRowid, owner]
    );

    return tx.get('SELECT * FROM policies WHERE id = ?', [existing.id]);
  }

  // No match — create a new policy at version 1
  const createdAt = effectiveDate || new Date().toISOString();
  const pol = tx.run(
    `INSERT INTO policies
       (title, owner, department, category, status, policy_no,
        approved_by, approved_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    [title.trim(), owner, department.trim(), category, policyno,
     approvedBy || null, approvedDate || null, createdAt, createdAt]
  );
  const policyId = pol.lastInsertRowid;

  const ver = tx.run(
    `INSERT INTO policy_versions
       (policy_id, version_number, metadata_json, body_html, change_summary, created_by)
     VALUES (?, 1, ?, ?, 'Imported via hot folder', ?)`,
    [policyId, metadata, content, owner]
  );

  tx.run(
    `INSERT INTO policy_workflow (policy_version_id, stage, actor, comments)
     VALUES (?, 'draft', ?, 'Imported via hot folder')`,
    [ver.lastInsertRowid, owner]
  );

  return tx.get('SELECT * FROM policies WHERE id = ?', [policyId]);
}

// Process one .docx file: parse banner + body → import → move to processed/ or failed/.
async function processDocxFile(filePath, db) {
  const filename = path.basename(filePath);
  const ts       = Date.now();

  try {
    const data = await parseDocx(filePath);

    let result;
    try {
      const policy = db.transaction(tx => importOne(data, tx));
      result = { success: true, id: policy.id, title: data.title };
    } catch (e) {
      result = { success: false, title: data.title || filename, error: e.message };
    }

    const ok      = result.success ? 1 : 0;
    const destDir = result.success ? PROCESSED_DIR : FAILED_DIR;
    const logKey  = result.success ? 'processed_at' : 'failed_at';
    fs.renameSync(filePath, path.join(destDir, `${ts}-${filename}`));
    fs.writeFileSync(
      path.join(destDir, `${ts}-${filename}.log`),
      JSON.stringify({ [logKey]: new Date().toISOString(), file: filename, imported: ok, failed: 1 - ok, results: [result] }, null, 2)
    );
    console.log(`[HotFolder] ${filename}: ${ok} imported, ${1 - ok} failed`);
  } catch (e) {
    console.error(`[HotFolder] Error processing ${filename}:`, e.message);
    try { fs.renameSync(filePath, path.join(FAILED_DIR, `${ts}-${filename}`)); } catch {}
    fs.writeFileSync(
      path.join(FAILED_DIR, `${ts}-${filename}.log`),
      JSON.stringify({ failed_at: new Date().toISOString(), file: filename, error: e.message }, null, 2)
    );
  }
}

// Process one JSON file: parse → import all policies → move to processed/ or failed/.
function processFile(filePath, db) {
  const filename = path.basename(filePath);
  const ts       = Date.now();

  try {
    const raw   = fs.readFileSync(filePath, 'utf8');
    const data  = JSON.parse(raw);
    const items = Array.isArray(data) ? data : [data];

    // All items in one transaction — one disk write per file.
    const results = db.transaction(tx =>
      items.map((item, i) => {
        try {
          const policy = importOne(item, tx);
          return { index: i, success: true, id: policy.id, title: item.title };
        } catch (e) {
          return { index: i, success: false, title: item.title || '(no title)', error: e.message };
        }
      })
    );

    const ok     = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    const destFile = path.join(PROCESSED_DIR, `${ts}-${filename}`);
    fs.renameSync(filePath, destFile);
    fs.writeFileSync(
      path.join(PROCESSED_DIR, `${ts}-${filename}.log`),
      JSON.stringify({ processed_at: new Date().toISOString(), file: filename, imported: ok, failed, results }, null, 2)
    );

    console.log(`[HotFolder] ${filename}: ${ok} imported, ${failed} failed`);
    return results;

  } catch (e) {
    console.error(`[HotFolder] Error processing ${filename}:`, e.message);
    try { fs.renameSync(filePath, path.join(FAILED_DIR, `${ts}-${filename}`)); } catch {}
    fs.writeFileSync(
      path.join(FAILED_DIR, `${ts}-${filename}.log`),
      JSON.stringify({ failed_at: new Date().toISOString(), file: filename, error: e.message }, null, 2)
    );
    throw e;
  }
}

function startWatcher(db) {
  console.log(`[HotFolder] Inbox: ${INBOX_DIR}`);

  const isSupportedFile = f => /\.(json|docx)$/i.test(f);

  async function dispatch(fp) {
    if (/\.docx$/i.test(fp)) await processDocxFile(fp, db);
    else processFile(fp, db);
  }

  // Pick up any files already sitting in inbox at startup.
  const existing = fs.readdirSync(INBOX_DIR).filter(isSupportedFile);
  if (existing.length) {
    console.log(`[HotFolder] Processing ${existing.length} existing file(s)…`);
    existing.forEach((f, i) =>
      setTimeout(async () => {
        const fp = path.join(INBOX_DIR, f);
        if (fs.existsSync(fp)) await dispatch(fp);
      }, i * 100)
    );
  }

  // Debounced watch — fs.watch can fire multiple events per file drop.
  const debounce = {};
  fs.watch(INBOX_DIR, (event, filename) => {
    if (!filename || !isSupportedFile(filename)) return;
    clearTimeout(debounce[filename]);
    debounce[filename] = setTimeout(async () => {
      delete debounce[filename];
      const fp = path.join(INBOX_DIR, filename);
      if (fs.existsSync(fp)) await dispatch(fp);
    }, 800);
  });
}

module.exports = { startWatcher, processFile, INBOX_DIR, PROCESSED_DIR, FAILED_DIR };
