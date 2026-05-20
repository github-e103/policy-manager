const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'policies.db');
let _db;

async function initDb() {
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file)
  });

  _db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  _db.run('PRAGMA foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS policies (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      title                TEXT    NOT NULL,
      owner                TEXT    NOT NULL,
      department           TEXT    NOT NULL,
      category             TEXT    NOT NULL,
      status               TEXT    NOT NULL DEFAULT 'draft',
      published_version_id INTEGER,
      locked_by            TEXT,
      locked_at            DATETIME,
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS policy_versions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id      INTEGER NOT NULL,
      version_number INTEGER NOT NULL,
      metadata_json  TEXT    NOT NULL,
      body_html      TEXT    NOT NULL DEFAULT '',
      change_summary TEXT             DEFAULT '',
      created_by     TEXT    NOT NULL DEFAULT 'System',
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS policy_workflow (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_version_id INTEGER NOT NULL,
      stage             TEXT    NOT NULL,
      actor             TEXT    NOT NULL DEFAULT 'System',
      comments          TEXT             DEFAULT '',
      actioned_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (policy_version_id) REFERENCES policy_versions(id) ON DELETE CASCADE
    );
  `);

  // Migrate existing databases — safe to run on fresh ones too (columns already exist)
  ['published_version_id INTEGER', 'locked_by TEXT', 'locked_at DATETIME', 'approved_by TEXT', 'approved_at DATETIME', 'policy_no TEXT'].forEach(col => {
    try { _db.run(`ALTER TABLE policies ADD COLUMN ${col}`); } catch {}
  });

  _persist();
}

function _persist() {
  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
}

function _all(sql, params = []) {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function _get(sql, params = []) {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  let row;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function _exec(sql, params = []) {
  _db.run(sql, params.length ? params : undefined);
  return { lastInsertRowid: _get('SELECT last_insert_rowid() as id').id };
}

const db = {
  all: _all,
  get: _get,

  run(sql, params = []) {
    const result = _exec(sql, params);
    _persist();
    return result;
  },

  transaction(fn) {
    _db.run('BEGIN');
    try {
      const tx = { run: _exec, get: _get, all: _all };
      const result = fn(tx);
      _db.run('COMMIT');
      _persist();
      return result;
    } catch (e) {
      _db.run('ROLLBACK');
      throw e;
    }
  }
};

module.exports = { initDb, db };
