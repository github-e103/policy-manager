require('dotenv').config();
require('./scripts/install-chrome-deps');
const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');
const { initDb, db } = require('./database/db');
const policiesRouter = require('./routes/policies');
const { startWatcher, processFile, importOne, INBOX_DIR } = require('./hotfolder/watcher');
const { parseDocx } = require('./hotfolder/docx-parser');
const multer = require('multer');
const os     = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

const exportsDir = path.join(__dirname, 'exports');
if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Sessions ──────────────────────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'pm-secret-change-me',
  resave:            false,
  saveUninitialized: false,
  cookie:            { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
}));

// ── Auth routes (unprotected) ─────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'frontend', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.redirect('/login?error=1');
  }
  req.session.user = {
    id:          user.id,
    username:    user.username,
    displayName: user.display_name,
    firstName:   user.first_name  || '',
    lastName:    user.last_name   || '',
    role:        user.role        || 'normal',
    title:       user.title       || '',
  };
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Current user info ─────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorised' });
  const { username, displayName, firstName, lastName, role, title } = req.session.user;
  res.json({ username, displayName, firstName, lastName, role, title });
});

// ── Change password ───────────────────────────────────────────────────────────
app.get('/change-password', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'frontend', 'change-password.html'));
});

app.post('/api/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const user = db.get('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  db.run('UPDATE users SET password_hash = ? WHERE id = ?',
    [bcrypt.hashSync(newPassword, 10), req.session.user.id]);
  res.json({ success: true });
});

// ── Admin guard ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session.user?.role !== 'admin') {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Forbidden' });
    return res.redirect('/');
  }
  next();
}

// ── Admin — user management ───────────────────────────────────────────────────
app.get('/admin/users', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'admin-users.html'));
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.all(
    `SELECT id, username, first_name, last_name, role, title, created_at FROM users ORDER BY created_at`
  );
  res.json(users);
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, firstName, lastName, role, title } = req.body;
  if (!username?.trim() || !firstName?.trim() || !lastName?.trim()) {
    return res.status(400).json({ error: 'Username, first name and last name are required' });
  }
  if (!['admin', 'approver', 'normal'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin, approver, or normal' });
  }
  try {
    const hash        = bcrypt.hashSync('changeme', 10);
    const displayName = `${firstName.trim()} ${lastName.trim()}`;
    const result      = db.run(
      `INSERT INTO users (username, password_hash, display_name, first_name, last_name, role, title)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [username.trim(), hash, displayName, firstName.trim(), lastName.trim(), role, title?.trim() || '']
    );
    res.status(201).json({ id: result.lastInsertRowid, username: username.trim(), firstName, lastName, role, title: title?.trim() || '' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: e.message });
  }
});

// ── Auth guard ────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorised' });
  res.redirect('/login');
});

// ── Protected routes ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/exports', express.static(exportsDir));
app.use('/tinymce', express.static(path.join(__dirname, 'node_modules', 'tinymce')));
app.use('/api/policies', policiesRouter);

app.post('/api/import/process-inbox', (req, res) => {
  const files = fs.readdirSync(INBOX_DIR).filter(f => f.toLowerCase().endsWith('.json'));
  if (!files.length) return res.json({ message: 'Inbox is empty', processed: [] });

  const summary = [];
  for (const f of files) {
    const fp = path.join(INBOX_DIR, f);
    try {
      const results = processFile(fp, db);
      summary.push({ file: f, ok: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results });
    } catch (e) {
      summary.push({ file: f, error: e.message });
    }
  }
  res.json({ processed: summary });
});

// ── Import page ───────────────────────────────────────────────────────────────
const upload = multer({
  dest: os.tmpdir(),
  fileFilter: (_req, file, cb) => {
    const ok = /\.(docx|json)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .docx and .json files are supported'), ok);
  },
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per file
});

app.get('/import', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'import.html'));
});

app.post('/api/import/upload', upload.array('files', 20), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No .docx or .json files received' });

  const results = [];
  for (const file of files) {
    const originalName = file.originalname;
    try {
      if (/\.json$/i.test(originalName)) {
        // JSON: array or single policy object with metadata + content (HTML)
        const raw   = fs.readFileSync(file.path, 'utf8');
        const items = (() => { const d = JSON.parse(raw); return Array.isArray(d) ? d : [d]; })();
        const batchResults = db.transaction(tx =>
          items.map((item, i) => {
            try {
              const policy = importOne(item, tx);
              return { file: originalName, success: true, id: policy.id, title: item.title, policy_no: item.policyno };
            } catch (e) {
              return { file: originalName, success: false, error: e.message };
            }
          })
        );
        results.push(...batchResults);
      } else {
        // DOCX: extract banner metadata + body HTML via mammoth
        const data   = await parseDocx(file.path);
        const policy = db.transaction(tx => importOne(data, tx));
        results.push({ file: originalName, success: true, id: policy.id, title: data.title, policy_no: data.policyno });
      }
    } catch (e) {
      results.push({ file: originalName, success: false, error: e.message });
    } finally {
      fs.unlink(file.path, () => {});
    }
  }

  const ok = results.filter(r => r.success).length;
  res.json({ imported: ok, failed: results.length - ok, results });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDb()
  .then(() => {
    startWatcher(db);
    app.listen(PORT, () => {
      console.log(`Policy Manager running at http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
