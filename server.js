require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { initDb, db } = require('./database/db');
const policiesRouter = require('./routes/policies');
const { startWatcher, processFile, INBOX_DIR } = require('./hotfolder/watcher');

const app = express();
const PORT = process.env.PORT || 3000;

const exportsDir = path.join(__dirname, 'exports');
if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/exports', express.static(exportsDir));
app.use('/tinymce', express.static(path.join(__dirname, 'node_modules', 'tinymce')));

app.use('/api/policies', policiesRouter);

// Manual trigger: process anything currently sitting in hotfolder/inbox
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

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
