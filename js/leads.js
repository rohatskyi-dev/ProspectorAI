/**
 * leads.js — ProspectorAI Leads Module Controller
 * ============================================================
 * Responsibilities:
 *   - State management (in-memory, Supabase-ready)
 *   - Rendering (table, stats, empty state, modals)
 *   - Search, filter, sort logic
 *   - Add / Edit / Delete / Status-update operations
 *   - CSV import / export
 *   - AI Search data ingestion entry point
 *
 * Architecture rules:
 *   • This file NEVER talks to a database directly.
 *     All I/O goes through /js/services/leadsService.js
 *   • All DOM writes go through render* functions.
 *   • State is the single source of truth — UI always
 *     reflects LeadsState, never the other way around.
 *
 * ⚡ SUPABASE: see /js/services/leadsService.js for swap points.
 * ============================================================
 */

'use strict';

import {
  getLeads,
  addLead,
  updateLead,
  removeLead,
  importLeadsFromCSV,
} from './services/leadsService.js';

/* ============================================================
   CONSTANTS
   ============================================================ */
const STATUS = {
  NEW:        'new',
  CONTACTED:  'contacted',
  INTERESTED: 'interested',
  CONVERTED:  'converted',
  REJECTED:   'rejected',
};

const STATUS_LABELS = {
  new:        'New',
  contacted:  'Contacted',
  interested: 'Interested',
  converted:  'Converted',
  rejected:   'Rejected',
};

const STATUS_BADGE = {
  new:        'lp-badge-gray',
  contacted:  'lp-badge-blue',
  interested: 'lp-badge-yellow',
  converted:  'lp-badge-green',
  rejected:   'lp-badge-red',
};

const INDUSTRIES = [
  'SaaS', 'Logistics', 'Fintech', 'Healthcare', 'Manufacturing',
  'Marketing', 'Consulting', 'E-commerce', 'Real Estate',
  'Education', 'Retail', 'Legal', 'Construction', 'Other',
];

const ITEMS_PER_PAGE = 20;
const DEBOUNCE_MS    = 260;

/* ============================================================
   STATE
   ============================================================ */
/**
 * LeadsState — single source of truth for this module.
 * Never mutate directly; always use the setter helpers below.
 *
 * @typedef {Object} LeadsState
 * @property {import('./services/leadsService').LeadRecord[]} all        — raw data from service
 * @property {import('./services/leadsService').LeadRecord[]} filtered   — after search + filter
 * @property {string}  searchQuery
 * @property {Object}  filters
 * @property {Object}  sort
 * @property {number}  page
 * @property {boolean} loading
 * @property {string|null} error
 * @property {string|null} activeLeadId   — lead open in detail modal
 */
const LeadsState = {
  all:          [],
  filtered:     [],
  searchQuery:  '',
  filters: {
    status:   '',
    industry: '',
    country:  '',
  },
  sort: {
    column:    'created_at',
    direction: 'desc',        // 'asc' | 'desc'
  },
  page:         1,
  loading:      false,
  error:        null,
  activeLeadId: null,
};

/* ── State helpers ─────────────────────────────────────────── */
function setState(patch) {
  Object.assign(LeadsState, patch);
}

function setLoading(bool) {
  setState({ loading: bool });
  const spinner = document.getElementById('leads-loading-spinner');
  const table   = document.getElementById('leads-table-wrap');
  if (spinner) spinner.hidden = !bool;
  if (table)   table.style.opacity = bool ? '0.4' : '1';
}

function setError(msg) {
  setState({ error: msg });
  const el = document.getElementById('leads-error-banner');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/* ============================================================
   INITIALISATION
   ============================================================ */
/**
 * init()
 * Entry point — called once when leads.html is loaded.
 * Wires all event listeners and fetches initial data.
 */
async function init() {
  wireEvents();
  await loadLeads();
}

/* ============================================================
   DATA OPERATIONS
   ============================================================ */

/**
 * loadLeads()
 * Fetch all leads from service, update state, re-render.
 *
 * ⚡ SUPABASE: getLeads() already returns a Promise —
 *   no change needed here when you swap the service layer.
 */
async function loadLeads() {
  setLoading(true);
  setError(null);
  try {
    const data = await getLeads();
    setState({ all: data, page: 1 });
    applySearchAndFilter();
    renderStats();
  } catch (err) {
    setError('Failed to load leads. Please refresh the page.');
    console.error('[LeadsModule] loadLeads:', err);
  } finally {
    setLoading(false);
  }
}

/**
 * createLead(formData)
 * Validate → send to service → refresh state → close modal.
 *
 * @param {FormData|Object} formData
 */
async function createLead(formData) {
  const payload = buildLeadPayload(formData);
  const errors  = validateLead(payload);

  if (errors.length) {
    showFormErrors(errors, 'add-lead-form');
    return;
  }

  const btn = document.getElementById('btn-add-lead-submit');
  setButtonLoading(btn, true);

  try {
    const created = await addLead({ ...payload, source: 'manual', status: STATUS.NEW });
    setState({ all: [created, ...LeadsState.all], page: 1 });
    applySearchAndFilter();
    renderStats();
    closeModal('modal-add-lead');
    showToast(`${created.company_name} added successfully.`, 'success');
  } catch (err) {
    showToast('Could not add lead. Please try again.', 'error');
    console.error('[LeadsModule] createLead:', err);
  } finally {
    setButtonLoading(btn, false);
  }
}

/**
 * editLead(id, changes)
 * Update specific fields of a lead.
 *
 * @param {string}  id
 * @param {Object}  changes
 */
async function editLead(id, changes) {
  try {
    const updated = await updateLead(id, changes);
    if (!updated) throw new Error('Lead not found');
    setState({ all: LeadsState.all.map(l => l.id === id ? updated : l) });
    applySearchAndFilter();
    renderStats();

    // If detail modal is open for this lead, refresh it
    if (LeadsState.activeLeadId === id) renderDetailModal(updated);

    showToast('Lead updated.', 'success');
    return updated;
  } catch (err) {
    showToast('Could not update lead.', 'error');
    console.error('[LeadsModule] editLead:', err);
  }
}

/**
 * deleteLead(id)
 * Remove a lead after confirmation.
 *
 * @param {string} id
 */
async function deleteLead(id) {
  const lead = LeadsState.all.find(l => l.id === id);
  if (!lead) return;

  const confirmed = await showConfirm(
    `Delete "${escapeHtml(lead.company_name)}"?`,
    'This action cannot be undone.',
  );
  if (!confirmed) return;

  try {
    await removeLead(id);
    setState({ all: LeadsState.all.filter(l => l.id !== id) });
    applySearchAndFilter();
    renderStats();
    closeModal('modal-lead-detail');
    closeModal('modal-add-lead');
    showToast(`${lead.company_name} deleted.`, 'info');
  } catch (err) {
    showToast('Could not delete lead.', 'error');
    console.error('[LeadsModule] deleteLead:', err);
  }
}

/**
 * updateLeadStatus(id, newStatus)
 * Convenience wrapper used by action buttons in table and modal.
 *
 * @param {string} id
 * @param {string} newStatus  — one of STATUS values
 */
async function updateLeadStatus(id, newStatus) {
  return editLead(id, { status: newStatus });
}

/* ============================================================
   SEARCH, FILTER, SORT
   ============================================================ */

/**
 * searchLeads(query)
 * Called on every keystroke (debounced).
 * Searches: company_name, email, contact_name, website, country.
 *
 * @param {string} query
 */
function searchLeads(query) {
  setState({ searchQuery: query.trim().toLowerCase(), page: 1 });
  applySearchAndFilter();
}

/**
 * filterLeads(filterPatch)
 * Apply one or more filter changes.
 *
 * @param {Partial<LeadsState['filters']>} filterPatch
 */
function filterLeads(filterPatch) {
  setState({ filters: { ...LeadsState.filters, ...filterPatch }, page: 1 });
  applySearchAndFilter();
}

/**
 * sortLeads(column)
 * Toggle sort direction if same column, else sort ascending.
 *
 * @param {string} column
 */
function sortLeads(column) {
  const { sort } = LeadsState;
  const direction = sort.column === column && sort.direction === 'asc' ? 'desc' : 'asc';
  setState({ sort: { column, direction }, page: 1 });
  applySearchAndFilter();
}

/**
 * applySearchAndFilter()
 * Master pipeline: filter → search → sort → paginate → render.
 * Called after any state change that affects the visible list.
 */
function applySearchAndFilter() {
  let result = [...LeadsState.all];

  /* 1. Status filter */
  if (LeadsState.filters.status) {
    result = result.filter(l => l.status === LeadsState.filters.status);
  }

  /* 2. Industry filter */
  if (LeadsState.filters.industry) {
    result = result.filter(l =>
      (l.industry || '').toLowerCase() === LeadsState.filters.industry.toLowerCase()
    );
  }

  /* 3. Country filter */
  if (LeadsState.filters.country) {
    result = result.filter(l =>
      (l.country || '').toLowerCase().includes(LeadsState.filters.country.toLowerCase())
    );
  }

  /* 4. Full-text search */
  if (LeadsState.searchQuery) {
    const q = LeadsState.searchQuery;
    result = result.filter(l =>
      (l.company_name  || '').toLowerCase().includes(q) ||
      (l.email         || '').toLowerCase().includes(q) ||
      (l.contact_name  || '').toLowerCase().includes(q) ||
      (l.website       || '').toLowerCase().includes(q) ||
      (l.country       || '').toLowerCase().includes(q)
    );
  }

  /* 5. Sort */
  const { column, direction } = LeadsState.sort;
  result.sort((a, b) => {
    let av = a[column] ?? '';
    let bv = b[column] ?? '';

    if (column === 'lead_score') {
      av = Number(av) || 0;
      bv = Number(bv) || 0;
    } else {
      av = String(av).toLowerCase();
      bv = String(bv).toLowerCase();
    }

    if (av < bv) return direction === 'asc' ? -1 : 1;
    if (av > bv) return direction === 'asc' ?  1 : -1;
    return 0;
  });

  setState({ filtered: result });
  renderTable();
  renderPagination();
  renderFilterCount();
  updateSortHeaders();
}

/* ============================================================
   PAGINATION
   ============================================================ */

function goToPage(n) {
  const total = Math.max(1, Math.ceil(LeadsState.filtered.length / ITEMS_PER_PAGE));
  const page  = Math.max(1, Math.min(n, total));
  setState({ page });
  renderTable();
  renderPagination();
}

function getPageSlice() {
  const start = (LeadsState.page - 1) * ITEMS_PER_PAGE;
  return LeadsState.filtered.slice(start, start + ITEMS_PER_PAGE);
}

/* ============================================================
   CSV IMPORT / EXPORT
   ============================================================ */

/**
 * handleCSVImport(file)
 * Parse a CSV file, normalise rows, bulk-insert via service.
 *
 * Expected CSV columns (case-insensitive, order-independent):
 *   company_name, website, contact_name, email, phone,
 *   industry, country, lead_score, status, notes
 *
 * @param {File} file
 */
async function handleCSVImport(file) {
  if (!file || !file.name.endsWith('.csv')) {
    showToast('Please select a valid .csv file.', 'error');
    return;
  }

  const text = await file.text();
  const rows = parseCSV(text);

  if (rows.length === 0) {
    showToast('The CSV file appears to be empty.', 'warn');
    return;
  }

  const validRows = rows.map(normaliseCSVRow).filter(r => r.company_name);

  if (validRows.length === 0) {
    showToast('No valid rows found. Make sure "company_name" column exists.', 'error');
    return;
  }

  setLoading(true);
  try {
    const imported = await importLeadsFromCSV(validRows);
    setState({ all: [...imported, ...LeadsState.all], page: 1 });
    applySearchAndFilter();
    renderStats();
    showToast(`${imported.length} leads imported successfully.`, 'success');
  } catch (err) {
    showToast('CSV import failed. Please try again.', 'error');
    console.error('[LeadsModule] handleCSVImport:', err);
  } finally {
    setLoading(false);
  }
}

/**
 * exportToCSV()
 * Download the currently-filtered lead list as a CSV file.
 */
function exportToCSV() {
  const headers = [
    'company_name', 'website', 'contact_name', 'email', 'phone',
    'industry', 'country', 'lead_score', 'status', 'created_at',
  ];

  const rows = LeadsState.filtered.map(l =>
    headers.map(h => `"${String(l[h] ?? '').replace(/"/g, '""')}"`).join(',')
  );

  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `prospector-leads-${formatDateForFilename(new Date())}.csv`,
  });
  a.click();
  URL.revokeObjectURL(url);
  showToast('Export started.', 'success');
}

/* ============================================================
   AI SEARCH INTEGRATION ENTRY POINT
   ============================================================
   When the AI Search module finds companies, it calls this
   function to push results into the Leads module.

   Usage (from ai-search.js):
     import { ingestAIResults } from './leads.js';
     await ingestAIResults(companiesArray);

   Each item in companiesArray should match LeadRecord shape.
   Missing fields are defaulted below.

   ⚡ SUPABASE: addLead() already goes through the service layer,
   so this function requires zero changes after migration.
   ============================================================ */

/**
 * ingestAIResults(companies)
 * Bulk-add AI-discovered companies as new leads.
 *
 * @param {Partial<import('./services/leadsService').LeadRecord>[]} companies
 * @returns {Promise<import('./services/leadsService').LeadRecord[]>}
 */
async function ingestAIResults(companies) {
  if (!Array.isArray(companies) || companies.length === 0) return [];

  setLoading(true);
  const created = [];

  try {
    for (const company of companies) {
      const payload = {
        company_name:  company.company_name  || company.name || 'Unknown',
        website:       company.website       || '',
        contact_name:  company.contact_name  || '',
        email:         company.email         || '',
        phone:         company.phone         || '',
        industry:      company.industry      || '',
        country:       company.country       || '',
        lead_score:    company.lead_score    ?? null,
        status:        STATUS.NEW,
        source:        'ai_search',
        notes:         company.notes         || '',
      };
      const record = await addLead(payload);
      created.push(record);
    }

    setState({ all: [...created, ...LeadsState.all], page: 1 });
    applySearchAndFilter();
    renderStats();
    showToast(`${created.length} leads added from AI Search.`, 'success');
    return created;
  } catch (err) {
    showToast('Failed to import AI results.', 'error');
    console.error('[LeadsModule] ingestAIResults:', err);
    return created;
  } finally {
    setLoading(false);
  }
}

/* ============================================================
   RENDERING
   ============================================================ */

/**
 * renderLeads()
 * Public re-render entry point.
 * Called when state changes from outside this module.
 */
function renderLeads() {
  applySearchAndFilter();
  renderStats();
}

/* ── Stats cards ────────────────────────────────────────────── */
function renderStats() {
  const all = LeadsState.all;

  const counts = {
    total:      all.length,
    new:        all.filter(l => l.status === STATUS.NEW).length,
    contacted:  all.filter(l => l.status === STATUS.CONTACTED).length,
    interested: all.filter(l => l.status === STATUS.INTERESTED).length,
    converted:  all.filter(l => l.status === STATUS.CONVERTED).length,
  };

  setStatCard('stat-total',      counts.total);
  setStatCard('stat-new',        counts.new);
  setStatCard('stat-contacted',  counts.contacted);
  setStatCard('stat-converted',  counts.converted);

  /* Conversion rate */
  const rate = counts.total > 0
    ? ((counts.converted / counts.total) * 100).toFixed(1) + '%'
    : '0%';
  setStatCard('stat-conversion', rate);
}

function setStatCard(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/* ── Table ──────────────────────────────────────────────────── */
function renderTable() {
  const tbody = document.getElementById('leads-table-body');
  if (!tbody) return;

  const page = getPageSlice();

  if (page.length === 0) {
    tbody.innerHTML = renderEmptyState();
    return;
  }

  tbody.innerHTML = page.map(renderTableRow).join('');
}

function renderTableRow(lead) {
  const score    = lead.lead_score != null ? lead.lead_score : null;
  const scoreHTML = score !== null
    ? `<span class="lp-score-badge ${scoreGradeClass(score)}" title="AI Score">${score}</span>`
    : `<span class="leads-no-score">—</span>`;

  const statusBadge = `<span class="lp-badge ${STATUS_BADGE[lead.status] || 'lp-badge-gray'}">${escapeHtml(STATUS_LABELS[lead.status] || lead.status)}</span>`;

  const initials   = avatarInitials(lead.company_name);
  const avatarColor = avatarColor_(lead.id);

  return `
  <tr data-lead-id="${escapeHtml(lead.id)}" class="leads-table-row" role="button" tabindex="0"
      aria-label="View details for ${escapeHtml(lead.company_name)}">
    <td class="col-check" style="padding-left:16px">
      <input type="checkbox" class="lp-checkbox leads-row-check"
             data-lead-id="${escapeHtml(lead.id)}"
             aria-label="Select ${escapeHtml(lead.company_name)}" />
    </td>
    <td>
      <div style="display:flex;align-items:center;gap:9px">
        <div class="leads-avatar" style="background:${avatarColor}" aria-hidden="true">${initials}</div>
        <div>
          <div class="leads-company-name">${escapeHtml(lead.company_name)}</div>
          ${lead.website ? `<div class="leads-company-sub">${escapeHtml(lead.website)}</div>` : ''}
        </div>
      </div>
    </td>
    <td class="leads-cell-muted">${lead.website ? `<a href="${escapeHtml(lead.website)}" target="_blank" rel="noopener" class="leads-link" onclick="event.stopPropagation()">${escapeHtml(lead.website)}</a>` : '—'}</td>
    <td>${lead.contact_name ? escapeHtml(lead.contact_name) : '<span class="leads-cell-muted">—</span>'}</td>
    <td>${lead.email ? `<a href="mailto:${escapeHtml(lead.email)}" class="leads-link" onclick="event.stopPropagation()">${escapeHtml(lead.email)}</a>` : '<span class="leads-cell-muted">—</span>'}</td>
    <td class="leads-cell-muted">${escapeHtml(lead.phone || '—')}</td>
    <td>${lead.industry ? `<span class="lp-badge lp-badge-gray">${escapeHtml(lead.industry)}</span>` : '<span class="leads-cell-muted">—</span>'}</td>
    <td class="leads-cell-muted">${escapeHtml(lead.country || '—')}</td>
    <td>${scoreHTML}</td>
    <td>${statusBadge}</td>
    <td class="col-actions" onclick="event.stopPropagation()">
      <div style="display:flex;gap:5px;align-items:center">
        <button type="button" class="btn btn-secondary btn-sm"
                data-action="open-detail" data-lead-id="${escapeHtml(lead.id)}"
                title="View details" aria-label="View ${escapeHtml(lead.company_name)}">
          View
        </button>
        <div class="leads-action-dropdown" data-lead-id="${escapeHtml(lead.id)}">
          <button type="button" class="btn btn-ghost btn-sm btn-icon leads-more-btn"
                  data-action="toggle-row-menu" data-lead-id="${escapeHtml(lead.id)}"
                  aria-haspopup="true" aria-expanded="false"
                  aria-label="More actions for ${escapeHtml(lead.company_name)}">
            •••
          </button>
          <div class="leads-row-menu lp-dropdown-menu" id="row-menu-${escapeHtml(lead.id)}" role="menu" hidden>
            <button type="button" class="lp-dropdown-item" role="menuitem"
                    data-action="mark-contacted" data-lead-id="${escapeHtml(lead.id)}">
              Mark Contacted
            </button>
            <button type="button" class="lp-dropdown-item" role="menuitem"
                    data-action="mark-converted" data-lead-id="${escapeHtml(lead.id)}">
              Mark Converted
            </button>
            <button type="button" class="lp-dropdown-item" role="menuitem"
                    data-action="generate-email" data-lead-id="${escapeHtml(lead.id)}">
              Generate Email
            </button>
            <div class="lp-dropdown-divider"></div>
            <button type="button" class="lp-dropdown-item danger" role="menuitem"
                    data-action="delete-lead" data-lead-id="${escapeHtml(lead.id)}">
              Delete
            </button>
          </div>
        </div>
      </div>
    </td>
  </tr>`;
}

function renderEmptyState() {
  const hasSearch  = LeadsState.searchQuery;
  const hasFilters = Object.values(LeadsState.filters).some(Boolean);

  if (hasSearch || hasFilters) {
    return `
    <tr><td colspan="11">
      <div class="leads-empty-state">
        <div class="leads-empty-icon" aria-hidden="true">🔍</div>
        <div class="leads-empty-title">No leads match your search</div>
        <div class="leads-empty-desc">Try adjusting your filters or search query.</div>
        <button type="button" class="btn btn-secondary" id="btn-clear-filters">Clear filters</button>
      </div>
    </td></tr>`;
  }

  return `
  <tr><td colspan="11">
    <div class="leads-empty-state">
      <div class="leads-empty-icon" aria-hidden="true">👥</div>
      <div class="leads-empty-title">No leads yet</div>
      <div class="leads-empty-desc">Add your first lead manually, import a CSV, or run an AI Search to discover companies.</div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button type="button" class="btn btn-primary" data-action="open-add-modal">+ Add Lead</button>
        <button type="button" class="btn btn-secondary" data-action="trigger-csv-import">Import CSV</button>
      </div>
    </div>
  </td></tr>`;
}

/* ── Pagination ─────────────────────────────────────────────── */
function renderPagination() {
  const wrap  = document.getElementById('leads-pagination');
  if (!wrap) return;

  const total = LeadsState.filtered.length;
  const pages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const cur   = LeadsState.page;
  const start = (cur - 1) * ITEMS_PER_PAGE + 1;
  const end   = Math.min(cur * ITEMS_PER_PAGE, total);

  if (total === 0) { wrap.innerHTML = ''; return; }

  /* Page number buttons — show max 5 */
  const range   = pageRange(cur, pages);
  const pageBtns = range.map(p =>
    p === '…'
      ? `<span class="leads-page-ellipsis">…</span>`
      : `<button type="button" class="lp-page-btn ${p === cur ? 'active' : ''}"
               data-action="go-to-page" data-page="${p}"
               aria-label="Page ${p}" ${p === cur ? 'aria-current="page"' : ''}>${p}</button>`
  ).join('');

  wrap.innerHTML = `
  <span class="leads-pagination-info">
    ${start}–${end} of <strong>${total}</strong> leads
  </span>
  <div class="leads-pagination-btns" role="navigation" aria-label="Pagination">
    <button type="button" class="lp-page-btn" data-action="go-to-page" data-page="${cur - 1}"
            aria-label="Previous page" ${cur <= 1 ? 'disabled' : ''}>←</button>
    ${pageBtns}
    <button type="button" class="lp-page-btn" data-action="go-to-page" data-page="${cur + 1}"
            aria-label="Next page" ${cur >= pages ? 'disabled' : ''}>→</button>
  </div>`;
}

function pageRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, '…', total];
  if (current >= total - 3) return [1, '…', total-4, total-3, total-2, total-1, total];
  return [1, '…', current-1, current, current+1, '…', total];
}

/* ── Filter result count ────────────────────────────────────── */
function renderFilterCount() {
  const el = document.getElementById('leads-result-count');
  if (el) {
    el.textContent = `${LeadsState.filtered.length} lead${LeadsState.filtered.length !== 1 ? 's' : ''}`;
  }
}

/* ── Sort header indicators ─────────────────────────────────── */
function updateSortHeaders() {
  document.querySelectorAll('#leads-table th[data-sort]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === LeadsState.sort.column) {
      th.classList.add(LeadsState.sort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

/* ── Populate filter dropdowns ──────────────────────────────── */
function renderIndustryOptions() {
  const sel = document.getElementById('filter-industry');
  if (!sel) return;
  const opts = INDUSTRIES.map(i => `<option value="${i}">${i}</option>`).join('');
  sel.innerHTML = `<option value="">All Industries</option>${opts}`;

  const modalSel = document.getElementById('add-lead-industry');
  if (modalSel) {
    modalSel.innerHTML = `<option value="">Select industry</option>${opts}`;
  }
}

/* ============================================================
   DETAIL MODAL
   ============================================================ */

/**
 * openLeadDetail(id)
 * Open the detail modal for a specific lead.
 *
 * @param {string} id
 */
function openLeadDetail(id) {
  const lead = LeadsState.all.find(l => l.id === id);
  if (!lead) return;
  setState({ activeLeadId: id });
  renderDetailModal(lead);
  openModal('modal-lead-detail');
}

function renderDetailModal(lead) {
  /* Header */
  setTextById('detail-company-name',  lead.company_name || '—');
  setTextById('detail-website',       lead.website || '—');
  setTextById('detail-contact',       lead.contact_name || '—');
  setTextById('detail-email',         lead.email || '—');
  setTextById('detail-phone',         lead.phone || '—');
  setTextById('detail-industry',      lead.industry || '—');
  setTextById('detail-country',       lead.country || '—');
  setTextById('detail-created',       formatDate(lead.created_at));
  setTextById('detail-source',        lead.source || 'manual');
  setTextById('detail-notes',         lead.notes || '—');

  /* Avatar */
  const avatarEl = document.getElementById('detail-avatar');
  if (avatarEl) {
    avatarEl.textContent = avatarInitials(lead.company_name);
    avatarEl.style.background = avatarColor_(lead.id);
  }

  /* AI Score */
  const scoreEl = document.getElementById('detail-score');
  if (scoreEl) {
    if (lead.lead_score != null) {
      scoreEl.innerHTML = `<span class="lp-score-badge ${scoreGradeClass(lead.lead_score)}" style="font-size:14px;width:auto;padding:4px 10px">${lead.lead_score} / 100</span>`;
    } else {
      scoreEl.textContent = 'Not scored yet';
    }
  }

  /* Score bar */
  const barFill = document.getElementById('detail-score-bar-fill');
  if (barFill) {
    const pct = lead.lead_score ?? 0;
    barFill.style.width = `${pct}%`;
    barFill.style.background = scoreColor(pct);
  }

  /* Status badge */
  const statusEl = document.getElementById('detail-status-badge');
  if (statusEl) {
    statusEl.className = `lp-badge ${STATUS_BADGE[lead.status] || 'lp-badge-gray'}`;
    statusEl.textContent = STATUS_LABELS[lead.status] || lead.status;
  }

  /* Status selector */
  const statusSel = document.getElementById('detail-status-select');
  if (statusSel) statusSel.value = lead.status;

  /* Delete button data */
  const delBtn = document.getElementById('btn-detail-delete');
  if (delBtn) delBtn.dataset.leadId = lead.id;

  /* Mark contacted button */
  const contactBtn = document.getElementById('btn-detail-mark-contacted');
  if (contactBtn) contactBtn.dataset.leadId = lead.id;

  /* Website link */
  const webLink = document.getElementById('detail-website-link');
  if (webLink) {
    if (lead.website) {
      webLink.href = lead.website.startsWith('http') ? lead.website : `https://${lead.website}`;
      webLink.textContent = lead.website;
      webLink.hidden = false;
    } else {
      webLink.hidden = true;
    }
  }
}

/* ============================================================
   ADD LEAD MODAL
   ============================================================ */

function openAddLeadModal() {
  resetAddLeadForm();
  openModal('modal-add-lead');
}

function resetAddLeadForm() {
  const form = document.getElementById('add-lead-form');
  if (form) form.reset();
  clearFormErrors('add-lead-form');
}

async function submitAddLeadForm() {
  const form = document.getElementById('add-lead-form');
  if (!form) return;
  const data = Object.fromEntries(new FormData(form));
  await createLead(data);
}

/* ============================================================
   VALIDATION
   ============================================================ */

/**
 * validateLead(payload)
 * Returns array of error objects {field, message}.
 *
 * @param {Object} payload
 * @returns {{ field: string, message: string }[]}
 */
function validateLead(payload) {
  const errors = [];
  if (!payload.company_name || payload.company_name.trim() === '') {
    errors.push({ field: 'company_name', message: 'Company name is required.' });
  }
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    errors.push({ field: 'email', message: 'Please enter a valid email address.' });
  }
  if (payload.website && payload.website.trim() !== '') {
    try { new URL(payload.website.startsWith('http') ? payload.website : `https://${payload.website}`); }
    catch { errors.push({ field: 'website', message: 'Please enter a valid website URL.' }); }
  }
  return errors;
}

function buildLeadPayload(data) {
  return {
    company_name:  String(data.company_name  || '').trim(),
    website:       String(data.website       || '').trim(),
    contact_name:  String(data.contact_name  || '').trim(),
    email:         String(data.email         || '').trim().toLowerCase(),
    phone:         String(data.phone         || '').trim(),
    industry:      String(data.industry      || '').trim(),
    country:       String(data.country       || '').trim(),
    lead_score:    data.lead_score ? Number(data.lead_score) : null,
    notes:         String(data.notes         || '').trim(),
  };
}

/* ============================================================
   CONFIRM DIALOG
   ============================================================ */

/**
 * showConfirm(title, body)
 * Returns a Promise<boolean>.
 * Resolves true if user clicks Confirm, false if Cancel.
 */
function showConfirm(title, body = '') {
  return new Promise(resolve => {
    const modal = document.getElementById('modal-confirm');
    const titleEl = document.getElementById('confirm-title');
    const bodyEl  = document.getElementById('confirm-body');
    const okBtn   = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');

    if (!modal || !okBtn || !cancelBtn) { resolve(true); return; }

    if (titleEl) titleEl.textContent = title;
    if (bodyEl)  bodyEl.textContent  = body;

    /* Clone to remove previous listeners */
    const newOk     = okBtn.cloneNode(true);
    const newCancel = cancelBtn.cloneNode(true);
    okBtn.replaceWith(newOk);
    cancelBtn.replaceWith(newCancel);

    newOk.addEventListener('click', () => { closeModal('modal-confirm'); resolve(true);  });
    newCancel.addEventListener('click', () => { closeModal('modal-confirm'); resolve(false); });

    openModal('modal-confirm');
  });
}

/* ============================================================
   MODAL HELPERS
   ============================================================ */

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.hidden = false;
    modal.removeAttribute('aria-hidden');
    /* Focus first focusable element */
    requestAnimationFrame(() => {
      const first = modal.querySelector('input, select, textarea, button:not([disabled])');
      if (first) first.focus();
    });
  }
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
  }
  if (id === 'modal-lead-detail') setState({ activeLeadId: null });
}

/* ============================================================
   TOAST NOTIFICATIONS
   ============================================================ */

/**
 * showToast(message, type)
 * Falls back to window.showToast() if the app-level system exists.
 *
 * @param {string} message
 * @param {'success'|'error'|'info'|'warn'} type
 */
function showToast(message, type = 'info') {
  /* Use existing app-level toast if available */
  if (typeof window.showToast === 'function') {
    window.showToast(message, type);
    return;
  }

  /* Standalone fallback */
  let container = document.getElementById('leads-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'leads-toast-container';
    container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px';
    document.body.appendChild(container);
  }

  const colors = { success: '#10B981', error: '#EF4444', warn: '#F59E0B', info: '#1F2937' };
  const icons  = { success: '✓', error: '✕', warn: '⚠', info: 'ℹ' };

  const toast = document.createElement('div');
  toast.style.cssText = `
    display:flex;align-items:center;gap:10px;padding:12px 16px;
    background:${colors[type] || colors.info};color:white;
    border-radius:10px;font-size:13px;font-weight:500;
    box-shadow:0 10px 25px rgba(0,0,0,0.15);min-width:240px;max-width:360px;
    animation:leadsToastIn 0.2s ease;
  `;
  toast.innerHTML = `<span>${icons[type] || icons.info}</span><span style="flex:1">${escapeHtml(message)}</span><button onclick="this.parentNode.remove()" style="background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;font-size:16px">✕</button>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

/* ============================================================
   EVENT WIRING
   ============================================================ */

const _debouncedSearch = debounce((val) => searchLeads(val), DEBOUNCE_MS);

function wireEvents() {
  /* ── Search ── */
  on('leads-search', 'input', e => _debouncedSearch(e.target.value));

  /* ── Filters ── */
  on('filter-status',   'change', e => filterLeads({ status:   e.target.value }));
  on('filter-industry', 'change', e => filterLeads({ industry: e.target.value }));
  on('filter-country',  'input',  debounce(e => filterLeads({ country: e.target.value }), DEBOUNCE_MS));
  on('btn-reset-filters', 'click', resetFilters);

  /* ── Header buttons ── */
  on('btn-add-lead',      'click', openAddLeadModal);
  on('btn-export-leads',  'click', exportToCSV);
  on('btn-import-csv',    'click', () => document.getElementById('csv-file-input')?.click());
  on('csv-file-input',    'change', e => {
    const file = e.target.files?.[0];
    if (file) { handleCSVImport(file); e.target.value = ''; }
  });

  /* ── Add Lead modal form ── */
  on('btn-add-lead-submit', 'click', submitAddLeadForm);
  on('add-lead-form', 'submit', e => { e.preventDefault(); submitAddLeadForm(); });
  on('btn-close-add-modal', 'click', () => closeModal('modal-add-lead'));
  on('modal-add-lead', 'click', e => { if (e.target === e.currentTarget) closeModal('modal-add-lead'); });

  /* ── Detail modal ── */
  on('btn-close-detail-modal', 'click', () => closeModal('modal-lead-detail'));
  on('modal-lead-detail', 'click', e => { if (e.target === e.currentTarget) closeModal('modal-lead-detail'); });

  on('btn-detail-delete', 'click', e => {
    const id = e.currentTarget.dataset.leadId;
    if (id) deleteLead(id);
  });

  on('btn-detail-mark-contacted', 'click', e => {
    const id = e.currentTarget.dataset.leadId;
    if (id) updateLeadStatus(id, STATUS.CONTACTED);
  });

  on('detail-status-select', 'change', e => {
    const id = LeadsState.activeLeadId;
    if (id) updateLeadStatus(id, e.target.value);
  });

  /* ── Select all checkbox ── */
  on('select-all-leads', 'change', e => {
    document.querySelectorAll('.leads-row-check').forEach(cb => cb.checked = e.target.checked);
    updateBulkBar();
  });

  /* ── Confirm modal ── */
  on('modal-confirm', 'click', e => { if (e.target === e.currentTarget) closeModal('modal-confirm'); });

  /* ── Global delegated click ── */
  document.addEventListener('click', handleDelegatedClick);

  /* ── Table: row click → detail ── */
  document.addEventListener('click', e => {
    const row = e.target.closest('.leads-table-row');
    if (row && !e.target.closest('[data-action]') && !e.target.closest('.lp-checkbox')) {
      openLeadDetail(row.dataset.leadId);
    }
  });

  /* ── Table: row keyboard → detail ── */
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const row = e.target.closest('.leads-table-row');
      if (row) openLeadDetail(row.dataset.leadId);
    }
    if (e.key === 'Escape') {
      closeModal('modal-add-lead');
      closeModal('modal-lead-detail');
      closeModal('modal-confirm');
      closeAllRowMenus();
    }
  });

  /* ── Sort headers ── */
  document.querySelectorAll('#leads-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => sortLeads(th.dataset.sort));
  });

  /* ── Populate selects ── */
  renderIndustryOptions();
}

function handleDelegatedClick(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const leadId = target.dataset.leadId;

  switch (action) {
    case 'open-add-modal':     openAddLeadModal(); break;
    case 'trigger-csv-import': document.getElementById('csv-file-input')?.click(); break;
    case 'open-detail':        if (leadId) openLeadDetail(leadId); break;
    case 'delete-lead':        if (leadId) { closeAllRowMenus(); deleteLead(leadId); } break;
    case 'mark-contacted':     if (leadId) { closeAllRowMenus(); updateLeadStatus(leadId, STATUS.CONTACTED); } break;
    case 'mark-converted':     if (leadId) { closeAllRowMenus(); updateLeadStatus(leadId, STATUS.CONVERTED); } break;
    case 'generate-email':     if (leadId) { closeAllRowMenus(); handleGenerateEmail(leadId); } break;

    case 'toggle-row-menu': {
      e.stopPropagation();
      const menuId = `row-menu-${leadId}`;
      const menu   = document.getElementById(menuId);
      if (!menu) break;
      const isOpen = !menu.hidden;
      closeAllRowMenus();
      if (!isOpen) {
        menu.hidden = false;
        target.setAttribute('aria-expanded', 'true');
      }
      break;
    }

    case 'go-to-page': {
      const n = parseInt(target.dataset.page, 10);
      if (!isNaN(n)) goToPage(n);
      break;
    }

    case 'btn-clear-filters': resetFilters(); break;
  }
}

function closeAllRowMenus() {
  document.querySelectorAll('.leads-row-menu').forEach(m => {
    m.hidden = true;
    const trigger = m.closest('.leads-action-dropdown')?.querySelector('[data-action="toggle-row-menu"]');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

/* Close row menus on outside click */
document.addEventListener('click', e => {
  if (!e.target.closest('.leads-action-dropdown')) closeAllRowMenus();
});

function resetFilters() {
  setState({ searchQuery: '', filters: { status: '', industry: '', country: '' }, page: 1 });
  const searchEl = document.getElementById('leads-search');
  if (searchEl) searchEl.value = '';
  ['filter-status','filter-industry','filter-country'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  applySearchAndFilter();
}

function updateBulkBar() {
  const checked = document.querySelectorAll('.leads-row-check:checked').length;
  const bar = document.getElementById('leads-bulk-bar');
  if (bar) {
    bar.hidden = checked === 0;
    const label = document.getElementById('bulk-selected-count');
    if (label) label.textContent = `${checked} selected`;
  }
}

/* ── Generate email stub ── */
function handleGenerateEmail(leadId) {
  const lead = LeadsState.all.find(l => l.id === leadId);
  if (!lead) return;
  /* ⚡ Integration point: fire event or call email-generator module */
  if (typeof window.openEmailGenerator === 'function') {
    window.openEmailGenerator({ company: lead.company_name, industry: lead.industry, contact: lead.contact_name });
  } else {
    showToast(`Opening email generator for ${lead.company_name}…`, 'info');
  }
}

/* ============================================================
   FORM HELPERS
   ============================================================ */

function showFormErrors(errors, formId) {
  clearFormErrors(formId);
  errors.forEach(({ field, message }) => {
    const input = document.querySelector(`#${formId} [name="${field}"]`);
    if (input) {
      input.classList.add('error');
      const err = document.getElementById(`err-${field}`);
      if (err) { err.textContent = message; err.hidden = false; }
    }
  });
}

function clearFormErrors(formId) {
  document.querySelectorAll(`#${formId} .lp-input`).forEach(el => el.classList.remove('error'));
  document.querySelectorAll(`#${formId} .lp-field-error`).forEach(el => {
    el.textContent = '';
    el.hidden = true;
  });
}

function setButtonLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  if (loading) btn.classList.add('btn-loading');
  else btn.classList.remove('btn-loading');
}

/* ============================================================
   UTILITY FUNCTIONS
   ============================================================ */

function on(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

function setTextById(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function formatDate(isoStr) {
  if (!isoStr) return '—';
  try {
    return new Date(isoStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return isoStr; }
}

function formatDateForFilename(date) {
  return date.toISOString().slice(0, 10);
}

function avatarInitials(name) {
  if (!name) return '?';
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function avatarColor_(seed) {
  const palette = [
    '#2563EB','#7C3AED','#0891B2','#059669',
    '#D97706','#DC2626','#DB2777','#0284C7',
  ];
  let h = 0;
  for (let i = 0; i < (seed || '').length; i++) h = (h << 5) - h + seed.charCodeAt(i);
  return palette[Math.abs(h) % palette.length];
}

function scoreGradeClass(score) {
  if (score >= 80) return 'score-A';
  if (score >= 60) return 'score-B';
  if (score >= 40) return 'score-C';
  return 'score-D';
}

function scoreColor(score) {
  if (score >= 80) return 'var(--green)';
  if (score >= 60) return 'var(--blue)';
  if (score >= 40) return 'var(--yellow)';
  return 'var(--red)';
}

/* ── CSV parser (RFC 4180 subset) ───────────────────────────── */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.replace(/^"|"$/g, '').trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

function normaliseCSVRow(row) {
  return {
    company_name:  row.company_name  || row.company || '',
    website:       row.website       || '',
    contact_name:  row.contact_name  || row.contact || '',
    email:         row.email         || '',
    phone:         row.phone         || '',
    industry:      row.industry      || '',
    country:       row.country       || '',
    lead_score:    row.lead_score    ? Number(row.lead_score) : null,
    status:        Object.values(STATUS).includes(row.status) ? row.status : STATUS.NEW,
    notes:         row.notes         || '',
    source:        'csv_import',
  };
}

/* ============================================================
   PUBLIC API
   Exposed on window so other modules (AI Search, Email Gen)
   can call into the Leads module without a bundler.

   With a bundler: use ES module exports instead.
   ============================================================ */
window.LeadsModule = {
  init,
  loadLeads,
  createLead,
  editLead,
  deleteLead,
  updateLeadStatus,
  searchLeads,
  filterLeads,
  sortLeads,
  renderLeads,
  ingestAIResults,    /* ← AI Search calls this */
  exportToCSV,
  handleCSVImport,
  openAddLeadModal,
  openLeadDetail,
  getState: () => ({ ...LeadsState }),
};

/* ── Auto-init when DOM is ready ────────────────────────────── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
