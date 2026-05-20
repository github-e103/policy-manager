/* ── Nav user area ──────────────────────────────────────── */
(async function setupNav() {
  const area = document.getElementById('nav-user-area');
  if (!area) return;
  try {
    const res  = await fetch('/api/me');
    if (!res.ok) return;
    const user = await res.json();
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;
    area.style.cssText = 'display:flex;align-items:center;gap:10px;margin-left:12px;';
    area.innerHTML = `
      <span style="font-size:.875rem;color:#555;">${escHtml(name)}</span>
      ${user.role === 'admin' ? '<a href="/admin/users" class="btn btn-outline btn-sm">Admin</a>' : ''}
      <a href="/change-password" class="btn btn-outline btn-sm">Change Password</a>
      <button class="btn btn-outline btn-sm" id="signout-btn">Sign Out</button>
    `;
    document.getElementById('signout-btn').addEventListener('click', async () => {
      await fetch('/logout', { method: 'POST' });
      location.href = '/login';
    });
  } catch {}
})();

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Shared utilities ──────────────────────────────────── */

function toast(msg, type = 'info') {
  const tc = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  tc.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 320);
  }, 3200);
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusBadge(s) {
  const labels = { draft: 'Draft', review: 'Under Review', approved: 'Approved', rejected: 'Rejected' };
  return `<span class="badge badge-${s}">${labels[s] || s}</span>`;
}

/* ══════════════════════════════════════════════════════════
   INDEX PAGE  (/index.html  or  /)
══════════════════════════════════════════════════════════ */
if (document.getElementById('policies-tbody')) {
  let allPolicies = [];
  let selectedIds = new Set();

  async function loadPolicies() {
    const tbody = document.getElementById('policies-tbody');
    tbody.innerHTML = '<tr><td colspan="9" class="loading-cell"><div class="spinner"></div> Loading policies…</td></tr>';
    try {
      const res = await fetch('/api/policies');
      if (!res.ok) throw new Error(await res.text());
      allPolicies = await res.json();
      selectedIds.clear();
      updateBatchBtn();
      renderTable(allPolicies);
      renderStats(allPolicies);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="9" class="error-cell">Failed to load policies: ${e.message}</td></tr>`;
    }
  }

  function updateBatchBtn() {
    const btn = document.getElementById('batch-download-btn');
    const count = document.getElementById('selected-count');
    count.textContent = selectedIds.size;
    btn.disabled = selectedIds.size === 0;
  }

  function renderStats(policies) {
    document.getElementById('stat-total').textContent    = policies.length;
    document.getElementById('stat-draft').textContent    = policies.filter(p => p.status === 'draft' && !p.published_version_id).length;
    document.getElementById('stat-review').textContent   = policies.filter(p => p.status === 'review').length;
    document.getElementById('stat-approved').textContent = policies.filter(p => p.published_version_id || p.status === 'approved').length;
  }

  function renderTable(policies) {
    const tbody   = document.getElementById('policies-tbody');
    const empty   = document.getElementById('empty-state');
    const wrapper = document.querySelector('.table-wrapper');

    if (!policies.length) {
      tbody.innerHTML = '';
      empty.style.display   = 'flex';
      wrapper.style.display = 'none';
      document.getElementById('select-all').checked = false;
      return;
    }
    empty.style.display   = 'none';
    wrapper.style.display = '';

    const LOCK_TTL_MS = 15 * 60 * 1000;
    tbody.innerHTML = policies.map(p => {
      const hasDraftOnApproved = p.published_version_id && p.status !== 'approved';
      const displayStatus = hasDraftOnApproved
        ? `${statusBadge('approved')}<span class="draft-chip">draft in progress</span>`
        : statusBadge(p.status);

      const displayVer = hasDraftOnApproved
        ? (p.published_version_number || 1)
        : (p.version_number || 1);

      const isLocked = p.locked_by && p.locked_at &&
        (Date.now() - new Date(p.locked_at).getTime()) < LOCK_TTL_MS;
      const lockedName = isLocked ? (p.locked_by.split('|')[1] || 'someone') : '';

      const checked = selectedIds.has(p.id) ? 'checked' : '';

      return `
      <tr>
        <td><input type="checkbox" class="row-check" data-id="${p.id}" ${checked}></td>
        <td><span class="policy-id">${esc(p.policy_no || '—')}</span></td>
        <td>
          <a class="policy-title-link" href="/editor.html?id=${p.id}">${esc(p.title)}</a>
          ${isLocked ? `<span class="in-edit-badge" title="Being edited by ${esc(lockedName)}">&#9998; ${esc(lockedName)}</span>` : ''}
          ${p.change_summary && !hasDraftOnApproved ? `<div class="policy-summary">${esc(p.change_summary)}</div>` : ''}
        </td>
        <td>${esc(p.owner)}</td>
        <td>${esc(p.department)}</td>
        <td>${displayStatus}</td>
        <td><span class="version-badge">v${displayVer}</span></td>
        <td>${fmtDate(p.updated_at)}</td>
        <td>
          <div class="action-btns">
            <a href="/editor.html?id=${p.id}" class="btn btn-outline btn-sm">Edit</a>
            ${p.published_version_id ? `<button class="btn btn-outline btn-sm" data-download="${p.id}" title="Download approved PDF">&#8595; PDF</button>` : ''}
            <button class="btn btn-danger btn-sm" data-delete="${p.id}" data-title="${esc(p.title)}">Delete</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    // Restore checkbox state after re-render
    tbody.querySelectorAll('.row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = parseInt(cb.dataset.id);
        cb.checked ? selectedIds.add(id) : selectedIds.delete(id);
        updateSelectAll();
        updateBatchBtn();
      });
    });
  }

  function updateSelectAll() {
    const checks = document.querySelectorAll('.row-check');
    const allChecked = checks.length > 0 && [...checks].every(c => c.checked);
    document.getElementById('select-all').checked = allChecked;
  }

  document.getElementById('select-all').addEventListener('change', function () {
    document.querySelectorAll('.row-check').forEach(cb => {
      cb.checked = this.checked;
      const id = parseInt(cb.dataset.id);
      this.checked ? selectedIds.add(id) : selectedIds.delete(id);
    });
    updateBatchBtn();
  });

  document.getElementById('batch-download-btn').addEventListener('click', async function () {
    if (!selectedIds.size) return;
    this.disabled = true;
    const orig = this.innerHTML;
    this.textContent = 'Generating ZIP…';
    try {
      const res = await fetch('/api/policies/batch-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `policies-export-${Date.now()}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast(`Downloaded ${selectedIds.size} policy PDF(s)`, 'success');
    } catch (e) {
      toast('Batch download failed: ' + e.message, 'error');
    } finally {
      this.disabled = false;
      this.innerHTML = orig;
    }
  });

  function filterPolicies() {
    const q      = document.getElementById('search-input').value.toLowerCase();
    const status = document.getElementById('status-filter').value;
    const filtered = allPolicies.filter(p => {
      const matchQ = !q || [p.title, p.owner, p.department, p.category].some(f => f && f.toLowerCase().includes(q));
      let matchS;
      if (!status) {
        matchS = true;
      } else if (status === 'approved') {
        // Approved filter includes policies with a published version (even if currently in draft/review)
        matchS = p.status === 'approved' || !!p.published_version_id;
      } else {
        matchS = p.status === status && !p.published_version_id;
      }
      return matchQ && matchS;
    });
    renderTable(filtered);
  }

  document.getElementById('search-input').addEventListener('input', filterPolicies);
  document.getElementById('status-filter').addEventListener('change', filterPolicies);

  document.getElementById('new-policy-btn').addEventListener('click', () => {
    window.location.href = '/editor.html';
  });

  document.getElementById('policies-tbody').addEventListener('click', async e => {
    const dlBtn = e.target.closest('[data-download]');
    if (dlBtn) {
      const id = dlBtn.dataset.download;
      dlBtn.disabled = true;
      dlBtn.textContent = '…';
      try {
        const res = await fetch(`/api/policies/${id}/export-pdf?published=true`, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        const { downloadUrl, filename } = await res.json();
        const a = document.createElement('a');
        a.href = downloadUrl; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        toast('PDF downloaded', 'success');
      } catch (err) {
        toast('PDF failed: ' + err.message, 'error');
      } finally {
        dlBtn.disabled = false;
        dlBtn.textContent = '↓ PDF';
      }
      return;
    }

    const btn = e.target.closest('[data-delete]');
    if (!btn) return;
    const id    = btn.dataset.delete;
    const title = btn.dataset.title;
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/policies/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      toast('Policy deleted', 'success');
      loadPolicies();
    } catch (e) {
      toast('Delete failed: ' + e.message, 'error');
    }
  });

  loadPolicies();
}

/* ══════════════════════════════════════════════════════════
   EDITOR PAGE  (/editor.html)
══════════════════════════════════════════════════════════ */
if (document.getElementById('editor-form')) {
  const params   = new URLSearchParams(window.location.search);
  const policyId = params.get('id') || null;

  // Stable per-tab session ID used for edit locking
  const SESSION_ID = (() => {
    let s = sessionStorage.getItem('pm_sid');
    if (!s) { s = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('pm_sid', s); }
    return s;
  })();

  const titleInput     = document.getElementById('title');
  const policyNoInput  = document.getElementById('policy-no');
  const ownerInput     = document.getElementById('owner');
  const departmentInput= document.getElementById('department');
  const categoryInput  = document.getElementById('category');
  const summaryInput   = document.getElementById('change-summary');
  const authorInput    = document.getElementById('created-by');

  let _editorReady = false;
  let _pendingBody = null;
  let _suppressStale = true;
  const getBody = () => tinymce.get('body-html')?.getContent() ?? '';
  const setBody = html => {
    if (_editorReady) {
      tinymce.get('body-html').setContent(html || '');
    } else {
      _pendingBody = html || '';
    }
  };

  tinymce.init({
    selector: '#body-html',
    license_key: 'gpl',
    base_url: '/tinymce',
    height: 520,
    resize: false,
    menubar: false,
    plugins: 'lists table link image code',
    toolbar:
      'undo redo | styles | bold italic underline | ' +
      'alignleft aligncenter alignright | bullist numlist | ' +
      'table link | removeformat | code',
    style_formats: [
      { title: 'Heading 1', block: 'h1' },
      { title: 'Heading 2', block: 'h2' },
      { title: 'Heading 3', block: 'h3' },
      { title: 'Paragraph', block: 'p'  },
    ],
    content_style: 'body { font-family: Segoe UI, Arial, sans-serif; font-size: 11pt; color: #2d3561; line-height: 1.75; }',
    setup(editor) {
      editor.on('init', () => {
        _editorReady = true;
        if (_pendingBody !== null) { editor.setContent(_pendingBody); _pendingBody = null; }
        generatePreview();
        setTimeout(() => { _suppressStale = false; }, 0);
      });
      editor.on('input change NodeChange', () => { if (!_suppressStale) markPreviewStale(); });
    },
  });

  const previewFrame   = document.getElementById('preview-frame');
  const saveBtn        = document.getElementById('save-btn');
  const exportBtn      = document.getElementById('export-pdf-btn');
  const pageTitle      = document.getElementById('editor-page-title');
  const versionLabel   = document.getElementById('current-version');

  let currentPolicy = null;
  let _currentUser  = null;

  fetch('/api/me').then(r => r.ok ? r.json() : null).then(u => {
    if (!u) return;
    _currentUser = u;
    if (!authorInput.value) authorInput.value = u.title || '';
    if (currentPolicy) renderWorkflowBar(currentPolicy.status);
  }).catch(() => {});

  /* ── PDF preview ───── */
  const previewLoading = document.getElementById('preview-loading');
  const previewLabel   = document.getElementById('preview-header-label');
  const previewStaleBar = document.getElementById('preview-stale-bar');
  let _previewAbort;
  let _previewBlobUrl;

  function markPreviewStale() {
    previewStaleBar.style.display = '';
  }

  document.getElementById('refresh-preview-btn').addEventListener('click', () => {
    previewStaleBar.style.display = 'none';
    generatePreview();
  });

  async function generatePreview() {
    if (_previewAbort) _previewAbort.abort();
    const controller = new AbortController();
    _previewAbort = controller;

    const payload = {
      title:          titleInput.value.trim()      || 'Untitled Policy',
      policy_no:      policyNoInput.value.trim()   || '',
      owner:          ownerInput.value.trim()      || '—',
      department:     departmentInput.value.trim() || '—',
      category:       categoryInput.value.trim()   || '—',
      status:         currentPolicy ? currentPolicy.status : 'draft',
      body_html:      getBody(),
      version_number: currentPolicy?.latestVersion?.version_number ?? 1,
      created_by:     authorInput.value.trim() || 'System',
    };

    try {
      const res = await fetch('/api/policies/preview-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('Preview failed');

      const blob = await res.blob();
      if (_previewBlobUrl) URL.revokeObjectURL(_previewBlobUrl);
      _previewBlobUrl = URL.createObjectURL(blob);
      previewFrame.src = _previewBlobUrl;
      previewLabel.textContent = 'PDF Preview';
    } catch (e) {
      if (e.name === 'AbortError') return;
      previewLabel.textContent = 'Preview unavailable';
    } finally {
      if (_previewAbort === controller) {
        previewLoading.style.display = 'none';
      }
    }
  }

  [titleInput, ownerInput, departmentInput, categoryInput].forEach(el =>
    el.addEventListener('input', markPreviewStale)
  );

  /* ── Edit lock ───── */
  const lockBanner     = document.getElementById('lock-banner');
  const lockBannerText = document.getElementById('lock-banner-text');
  document.getElementById('lock-banner-close')
    .addEventListener('click', () => lockBanner.style.display = 'none');

  let _heartbeat;

  async function acquireLock() {
    if (!policyId) return;
    try {
      const res = await fetch(`/api/policies/${policyId}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: SESSION_ID, display_name: authorInput.value.trim() || 'Unknown' }),
      });
      if (res.status === 409) {
        const d = await res.json();
        const since = new Date(d.locked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        lockBannerText.textContent =
          `This policy is currently being edited by ${d.locked_by_name} (since ${since}). Saving may overwrite their changes.`;
        lockBanner.style.display = '';
      } else {
        lockBanner.style.display = 'none';
        clearInterval(_heartbeat);
        _heartbeat = setInterval(() => {
          fetch(`/api/policies/${policyId}/lock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: SESSION_ID, display_name: authorInput.value.trim() || 'Unknown' }),
          }).catch(() => {});
        }, 5 * 60 * 1000);
      }
    } catch {}
  }

  function releaseLock() {
    if (!policyId) return;
    clearInterval(_heartbeat);
    navigator.sendBeacon(`/api/policies/${policyId}/unlock`,
      new Blob([JSON.stringify({ session_id: SESSION_ID })], { type: 'application/json' }));
  }

  window.addEventListener('beforeunload', releaseLock);

  /* ── Workflow bar ───── */
  function renderWorkflowBar(status) {
    const stages = [
      { key: 'draft',    label: 'Draft',    icon: '1' },
      { key: 'review',   label: 'Review',   icon: '2' },
      { key: 'approved', label: 'Approved', icon: '✓' },
    ];
    const rejected = status === 'rejected';

    if (rejected) {
      document.getElementById('workflow-bar').innerHTML = `
        <div class="workflow-stages">
          <div class="workflow-stage rejected">
            <div class="stage-dot">✗</div>
            <div class="stage-label">Rejected</div>
          </div>
        </div>`;
    } else {
      const order = ['draft', 'review', 'approved'];
      const cur   = order.indexOf(status);
      let html = '<div class="workflow-stages">';
      stages.forEach((s, i) => {
        const cls = i < cur ? 'completed' : i === cur ? 'active' : '';
        html += `<div class="workflow-stage ${cls}">
          <div class="stage-dot">${i < cur ? '✓' : s.icon}</div>
          <div class="stage-label">${s.label}</div>
        </div>`;
        if (i < stages.length - 1) {
          html += `<div class="stage-connector ${i < cur ? 'completed' : ''}"></div>`;
        }
      });
      html += '</div>';
      document.getElementById('workflow-bar').innerHTML = html;
    }

    const show = id => { const el = document.getElementById(id); if (el) el.style.display = ''; };
    const hide = id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };

    ['workflow-review-btn','workflow-approve-btn','workflow-reject-btn','workflow-reopen-btn'].forEach(hide);
    if (!policyId) return;

    const canApprove = ['admin', 'approver'].includes(_currentUser?.role);

    if (status === 'draft')  { show('workflow-review-btn'); }
    if (status === 'review') {
      if (canApprove) { show('workflow-approve-btn'); show('workflow-reject-btn'); }
    }
    if (status === 'approved' || status === 'rejected') {
      if (canApprove) show('workflow-reopen-btn');
    }
  }

  /* ── Load policy ───── */
  async function loadPolicy() {
    if (!policyId) {
      renderWorkflowBar('draft');
      generatePreview();
      return;
    }
    try {
      const res = await fetch(`/api/policies/${policyId}`);
      if (!res.ok) throw new Error('Policy not found');
      currentPolicy = await res.json();

      titleInput.value      = currentPolicy.title      || '';
      policyNoInput.value   = currentPolicy.policy_no  || '';
      ownerInput.value      = currentPolicy.owner      || '';
      departmentInput.value = currentPolicy.department || '';
      categoryInput.value   = currentPolicy.category   || '';
      summaryInput.value    = '';
      authorInput.value     = '';

      if (currentPolicy.latestVersion) {
        setBody(currentPolicy.latestVersion.body_html || '');
        versionLabel.textContent = `v${currentPolicy.latestVersion.version_number}`;
      }

      pageTitle.textContent = currentPolicy.title;
      renderWorkflowBar(currentPolicy.status);
      document.getElementById('history-btn').style.display = '';
      acquireLock();
    } catch (e) {
      toast('Failed to load policy: ' + e.message, 'error');
    }
  }

  /* ── Save ───── */
  saveBtn.addEventListener('click', async () => {
    const title      = titleInput.value.trim();
    const owner      = ownerInput.value.trim();
    const department = departmentInput.value.trim();
    const category   = categoryInput.value.trim();

    if (!title || !owner || !department || !category) {
      toast('Title, Owner, Department, and Category are required', 'error');
      return;
    }

    const payload = {
      title, owner, department, category,
      policy_no:      policyNoInput.value.trim() || undefined,
      body_html:      getBody(),
      change_summary: summaryInput.value.trim() || undefined,
      created_by:     authorInput.value.trim()  || undefined,
    };

    saveBtn.disabled = true;
    try {
      const res = policyId
        ? await fetch(`/api/policies/${policyId}`, { method: 'PUT',  headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
        : await fetch('/api/policies',              { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });

      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const saved = await res.json();

      if (!policyId) {
        releaseLock();
        window.location.href = `/editor.html?id=${saved.id}`;
        return;
      }
      toast('Policy saved', 'success');
      loadPolicy();
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  /* ── Workflow transitions ───── */
  async function doWorkflow(stage) {
    if (!policyId) return;
    const actor    = authorInput.value.trim() || 'System';
    const comments = stage === 'rejected' ? (prompt('Reason for rejection (optional):') || '') : '';
    try {
      const res = await fetch(`/api/policies/${policyId}/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage, actor, comments }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      toast(`Status updated to ${stage}`, 'success');
      loadPolicy();
    } catch (e) {
      toast('Workflow update failed: ' + e.message, 'error');
    }
  }

  document.getElementById('workflow-review-btn') ?.addEventListener('click', () => doWorkflow('review'));
  document.getElementById('workflow-approve-btn')?.addEventListener('click', () => doWorkflow('approved'));
  document.getElementById('workflow-reject-btn') ?.addEventListener('click', () => doWorkflow('rejected'));
  document.getElementById('workflow-reopen-btn') ?.addEventListener('click', () => doWorkflow('draft'));

  /* ── PDF export ───── */
  exportBtn.addEventListener('click', async () => {
    if (!policyId) { toast('Save the policy first before exporting', 'info'); return; }
    exportBtn.disabled = true;
    exportBtn.textContent = 'Generating…';
    try {
      const res = await fetch(`/api/policies/${policyId}/export-pdf`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const { downloadUrl, filename } = await res.json();
      const a = document.createElement('a');
      a.href = downloadUrl; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      toast('PDF downloaded', 'success');
    } catch (e) {
      toast('PDF export failed: ' + e.message, 'error');
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = '↓ Export PDF';
    }
  });

  /* ── Version History & Diff ───── */
  const historyBtn    = document.getElementById('history-btn');
  const historyModal  = document.getElementById('history-modal');
  const historyClose  = document.getElementById('history-close');
  const versionList   = document.getElementById('version-list');
  const diffContent   = document.getElementById('diff-content');
  const diffMeta      = document.getElementById('diff-meta');
  const diffFromLabel = document.getElementById('diff-from-label');
  const diffToLabel   = document.getElementById('diff-to-label');
  const compareToggle = document.getElementById('compare-toggle');
  const compareHint   = document.getElementById('compare-hint');

  let compareMode = false;
  let compareFrom = null;
  let _versions   = [];
  let _diffFrom   = null;
  let _diffTo     = null;

  const redlinePdfBtn = document.getElementById('redline-pdf-btn');

  function openHistory() {
    if (!policyId) return;
    compareMode = false;
    compareFrom = null;
    _diffFrom = null;
    _diffTo   = null;
    compareToggle.textContent = 'Compare two';
    compareHint.style.display = 'none';
    diffContent.innerHTML = '<p class="diff-placeholder">Select a version on the left to see changes.</p>';
    diffMeta.style.display = 'none';
    historyModal.style.display = 'flex';
    loadVersionList();
  }

  async function loadVersionList() {
    versionList.innerHTML = '<li style="padding:12px 14px;color:var(--text-muted);font-size:.8rem">Loading…</li>';
    const res = await fetch(`/api/policies/${policyId}/versions`);
    _versions = await res.json();
    const versions = _versions;

    versionList.innerHTML = versions.map(v => {
      const isPublished = currentPolicy && v.id == currentPolicy.published_version_id;
      return `
      <li class="version-item" data-ver="${v.version_number}" data-ver-id="${v.id}">
        <div class="version-item-top">
          <span class="version-item-num">Version ${v.version_number}${isPublished ? ' <span class="version-published-badge">Approved</span>' : ''}</span>
          <button class="version-dl-btn" data-dl-ver-id="${v.id}" title="Download this version as PDF">&#8595;</button>
        </div>
        <div class="version-item-meta">${fmtDate(v.created_at)} &bull; ${esc(v.created_by || 'System')}</div>
        ${v.change_summary ? `<div class="version-item-sum">${esc(v.change_summary)}</div>` : ''}
      </li>`;
    }).join('');

    versionList.querySelectorAll('.version-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.version-dl-btn')) return; // let download button handle it
        onVersionClick(el, versions);
      });
    });

    versionList.querySelectorAll('.version-dl-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const verId = btn.dataset.dlVerId;
        btn.disabled = true;
        btn.textContent = '…';
        try {
          const res = await fetch(`/api/policies/${policyId}/export-pdf`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version_id: parseInt(verId) }),
          });
          if (!res.ok) throw new Error((await res.json()).error || res.statusText);
          const { downloadUrl, filename } = await res.json();
          const a = document.createElement('a');
          a.href = downloadUrl; a.download = filename;
          document.body.appendChild(a); a.click(); a.remove();
          toast('PDF downloaded', 'success');
        } catch (err) {
          toast('Download failed: ' + err.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = '↓';
        }
      });
    });
  }

  function onVersionClick(el, versions) {
    const ver = parseInt(el.dataset.ver);

    if (compareMode) {
      if (compareFrom === null) {
        compareFrom = ver;
        versionList.querySelectorAll('.version-item').forEach(e => e.classList.remove('compare-from','compare-to','active'));
        el.classList.add('compare-from');
        compareHint.textContent = 'Now pick the "to" version';
      } else {
        const from = Math.min(compareFrom, ver);
        const to   = Math.max(compareFrom, ver);
        versionList.querySelectorAll('.version-item').forEach(e => {
          e.classList.remove('compare-from','compare-to','active');
          const v = parseInt(e.dataset.ver);
          if (v === from) e.classList.add('compare-from');
          if (v === to)   e.classList.add('compare-to');
        });
        compareFrom = null;
        compareHint.textContent = 'Pick a second version';
        showDiff(from, to);
      }
      return;
    }

    // Normal click: diff this version vs the previous one
    versionList.querySelectorAll('.version-item').forEach(e => e.classList.remove('active','compare-from','compare-to'));
    el.classList.add('active');

    const idx = _versions.findIndex(v => v.version_number === ver);
    const prev = _versions[idx + 1]; // versions are DESC
    if (!prev) {
      diffMeta.style.display = 'none';
      diffContent.innerHTML = '<p class="diff-placeholder">This is the first version — nothing to compare against.</p>';
      return;
    }
    showDiff(prev.version_number, ver);
  }

  async function showDiff(from, to) {
    diffContent.innerHTML = '<p class="diff-placeholder">Computing diff…</p>';
    diffMeta.style.display = 'none';
    try {
      const res  = await fetch(`/api/policies/${policyId}/diff?from=${from}&to=${to}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      diffFromLabel.textContent = `v${data.from.version_number} — ${fmtDate(data.from.created_at)}`;
      diffToLabel.textContent   = `v${data.to.version_number} — ${fmtDate(data.to.created_at)}`;
      diffMeta.style.display = 'flex';
      _diffFrom = from;
      _diffTo   = to;

      if (data.unchanged) {
        diffContent.innerHTML = '<p class="diff-unchanged">No text changes between these versions.</p>';
      } else {
        diffContent.innerHTML = data.diffHtml;
      }
    } catch (e) {
      diffContent.innerHTML = `<p class="diff-placeholder" style="color:var(--danger)">Failed to load diff: ${e.message}</p>`;
    }
  }

  redlinePdfBtn.addEventListener('click', async () => {
    if (!_diffFrom || !_diffTo) return;
    redlinePdfBtn.disabled = true;
    redlinePdfBtn.textContent = 'Generating…';
    try {
      const res = await fetch(`/api/policies/${policyId}/export-redline-pdf?from=${_diffFrom}&to=${_diffTo}`);
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const { downloadUrl, filename } = await res.json();
      const a = document.createElement('a');
      a.href = downloadUrl; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      toast('Redline PDF downloaded', 'success');
    } catch (e) {
      toast('Redline PDF failed: ' + e.message, 'error');
    } finally {
      redlinePdfBtn.disabled = false;
      redlinePdfBtn.textContent = '↓ Redline PDF';
    }
  });

  compareToggle.addEventListener('click', () => {
    compareMode = !compareMode;
    compareFrom = null;
    compareToggle.textContent = compareMode ? 'Cancel compare' : 'Compare two';
    compareHint.style.display = compareMode ? '' : 'none';
    if (compareMode) compareHint.textContent = 'Pick the "from" version';
    versionList.querySelectorAll('.version-item').forEach(e => e.classList.remove('active','compare-from','compare-to'));
  });

  historyBtn.addEventListener('click', openHistory);
  historyClose.addEventListener('click', () => { historyModal.style.display = 'none'; });
  historyModal.addEventListener('click', e => { if (e.target === historyModal) historyModal.style.display = 'none'; });

  loadPolicy();
}

/* ── HTML escape helper ── */
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
