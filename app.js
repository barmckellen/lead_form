// ============================================
// CONFIG — fetched from /api/config (Cloudflare Pages Functions)
// ============================================
let SUPABASE_URL = '';
let SUPABASE_KEY = '';
let SUPABASE_SCHEMA = 'leads';
let N8N_WEBHOOK_URL = '';

async function loadConfig() {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    SUPABASE_URL = cfg.SUPABASE_URL || '';
    SUPABASE_KEY = cfg.SUPABASE_KEY || '';
    SUPABASE_SCHEMA = cfg.SUPABASE_SCHEMA || 'leads';
    N8N_WEBHOOK_URL = cfg.N8N_WEBHOOK_URL || '';
}

// ============================================
// STATE
// ============================================
let projects = [];
let categories = [];
let searchQueries = [];
let searchQueryRuns = [];

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    updateDbStatus('connecting');
    try {
        await loadConfig();
    } catch (err) {
        console.error('Config load failed:', err);
        updateDbStatus('error');
        return;
    }
    const ok = await Promise.all([
        loadProjects(),
        loadCategories(),
        loadSearchQueries(),
        loadSearchQueryRuns()
    ]);
    const failed = ok.some(r => r === false);
    updateDbStatus(failed ? 'error' : 'connected');
    setupEventListeners();
    updateQueryPreview();
});

// ============================================
// SUPABASE REST API
// ============================================
async function supabaseRequest(method, endpoint, body = null, params = {}) {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase config — check Cloudflare Worker env vars');
    const queryString = new URLSearchParams(params).toString();
    const url = `${SUPABASE_URL}/rest/v1/${endpoint}${queryString ? '?' + queryString : ''}`;

    const headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Accept-Profile': SUPABASE_SCHEMA
    };

    if (method === 'POST') {
        headers['Prefer'] = 'return=representation';
    }

    const options = { method, headers };

    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Supabase ${method} ${endpoint}: ${res.status} — ${err}`);
    }
    return res.json();
}

const get = (endpoint, params) => supabaseRequest('GET', endpoint, null, params);
const post = (endpoint, body) => supabaseRequest('POST', endpoint, body);

// ============================================
// LOAD DATA (returns true/false for status)
// ============================================
async function loadProjects() {
    try {
        projects = await get('projects', {
            select: 'id,name,category_id',
            order: 'name'
        });
        return true;
    } catch (err) {
        console.error('Load projects failed:', err);
        return false;
    }
}

async function loadCategories() {
    try {
        categories = await get('categories', {
            select: 'id,name',
            order: 'name'
        });
        return true;
    } catch (err) {
        console.error('Load categories failed:', err);
        return false;
    }
}

async function loadSearchQueries() {
    try {
        searchQueries = await get('search_queries', {
            select: 'id,category_id,search_engine,target_platform,country'
        });
        return true;
    } catch (err) {
        console.error('Load search_queries failed:', err);
        return false;
    }
}

async function loadSearchQueryRuns() {
    try {
        searchQueryRuns = await get('search_query_runs', {
            select: 'id,search_query_id,last_page_fetched,results_returned_count,run_at',
            order: 'run_at.desc'
        });
        return true;
    } catch (err) {
        console.error('Load search_query_runs failed:', err);
        return false;
    }
}

// ============================================
// COMBO CHECK LOGIC (PURE JS — NO SQL FUNCTIONS)
// ============================================
function findSearchQuery(categoryId, searchEngine, targetPlatform, country) {
    return searchQueries.find(sq =>
        sq.category_id === parseInt(categoryId) &&
        sq.search_engine === searchEngine &&
        sq.target_platform === (targetPlatform || null) &&
        sq.country === (country || null)
    );
}

function getLatestRun(searchQueryId) {
    return searchQueryRuns
        .filter(r => r.search_query_id === searchQueryId)
        .sort((a, b) => new Date(b.run_at) - new Date(a.run_at))[0] || null;
}

function checkComboStatus(categoryId, searchEngine, targetPlatform, country) {
    const sq = findSearchQuery(categoryId, searchEngine, targetPlatform, country);

    if (!sq) return { status: 'new', searchQueryId: null, lastPage: 0, lastRun: null };

    const latestRun = getLatestRun(sq.id);

    if (!latestRun) return { status: 'new', searchQueryId: sq.id, lastPage: 0, lastRun: null };

    if (latestRun.results_returned_count === 0) {
        return { status: 'exhausted', searchQueryId: sq.id, lastPage: latestRun.last_page_fetched, lastRun: latestRun };
    }

    return {
        status: 'resume',
        searchQueryId: sq.id,
        lastPage: latestRun.last_page_fetched,
        lastRun: latestRun
    };
}

// ============================================
// AUTOCOMPLETE
// ============================================
function setupAutocomplete(inputId, dropdownId, items, onSelect, allowCreate = true) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    let debounce;

    input.addEventListener('input', () => {
        clearTimeout(debounce);
        const query = input.value.toLowerCase().trim();

        if (!query) {
            dropdown.classList.add('hidden');
            return;
        }

        debounce = setTimeout(() => {
            const filtered = items.filter(i => i.name.toLowerCase().includes(query));
            renderDropdown(dropdown, filtered, query, onSelect, allowCreate);
        }, 100);
    });

    input.addEventListener('focus', () => {
        if (input.value.trim()) input.dispatchEvent(new Event('input'));
    });

    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
}

function renderDropdown(dropdown, items, query, onSelect, allowCreate) {
    dropdown.innerHTML = '';

    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'dropdown-item';
        div.innerHTML = `<div class="item-name">${highlight(item.name, query)}</div>`;
        div.addEventListener('click', () => {
            onSelect(item);
            dropdown.classList.add('hidden');
        });
        dropdown.appendChild(div);
    });

    if (allowCreate && query && !items.some(i => i.name.toLowerCase() === query.toLowerCase())) {
        const div = document.createElement('div');
        div.className = 'dropdown-item create-new';
        div.innerHTML = `<div class="item-name">+ Create "${esc(query)}"</div>`;
        div.addEventListener('click', () => {
            onSelect({ id: null, name: query, isNew: true });
            dropdown.classList.add('hidden');
        });
        dropdown.appendChild(div);
    }

    dropdown.classList.toggle('hidden', dropdown.children.length === 0);
}

function highlight(text, query) {
    const r = new RegExp(`(${escRe(query)})`, 'gi');
    return esc(text).replace(r, '<mark>$1</mark>');
}

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================
// DB STATUS INDICATOR
// ============================================
function updateDbStatus(state) {
    const el = document.getElementById('dbStatus');
    if (!el) return;
    el.className = 'db-status ' + state;
    if (state === 'connecting') {
        el.innerHTML = '<span class="db-dot"></span> Connecting to DB...';
    } else if (state === 'connected') {
        el.innerHTML = '<span class="db-dot"></span> Connected to DB';
    } else {
        el.innerHTML = '<span class="db-dot"></span> DB Error — check config / schema';
    }
}

// ============================================
// EVENT LISTENERS
// ============================================
function setupEventListeners() {
    setupAutocomplete('projectSearch', 'projectDropdown', projects, (item) => {
        document.getElementById('projectSearch').value = item.name;
        document.getElementById('projectId').value = item.id || '';

        if (item.isNew) {
            document.getElementById('newProjectFields').classList.remove('hidden');
            document.getElementById('newProjectName').value = item.name;
        } else {
            document.getElementById('newProjectFields').classList.add('hidden');
            if (item.category_id) {
                const cat = categories.find(c => c.id === item.category_id);
                if (cat) {
                    document.getElementById('categorySearch').value = cat.name;
                    document.getElementById('categoryId').value = cat.id;
                }
            }
        }
    });

    setupAutocomplete('categorySearch', 'categoryDropdown', categories, (item) => {
        document.getElementById('categorySearch').value = item.name;
        document.getElementById('categoryId').value = item.id || '';
        updateQueryPreview();
    });

    setupAutocomplete('profession', 'professionDropdown', categories, (item) => {
        document.getElementById('profession').value = item.name;
        updateQueryPreview();
    }, false);

    document.getElementById('btnNewProject').addEventListener('click', () => {
        document.getElementById('newProjectFields').classList.remove('hidden');
        document.getElementById('projectSearch').value = '';
        document.getElementById('projectId').value = '';
        document.getElementById('newProjectName').focus();
    });

    ['profession', 'targetPlatform', 'country', 'searchEngine', 'categorySearch'].forEach(id => {
        document.getElementById(id).addEventListener('input', updateQueryPreview);
    });

    document.getElementById('btnTestQuery').addEventListener('click', () => {
        const q = buildQuery();
        const engine = document.getElementById('searchEngine').value;
        window.open(`https://${engine}/search?q=${encodeURIComponent(q)}`, '_blank');
    });

    document.getElementById('researchForm').addEventListener('submit', handleSubmit);
}

// ============================================
// QUERY BUILDER
// ============================================
const EMAIL_PROVIDERS = [
    '"@gmail.com"',
    '"@yahoo.com"',
    '"hotmail.com"',
    '"@outlook.com"',
    '"@aol.com"',
    '"@icloud.com"'
];

function buildQuery() {
    const parts = [];
    const prof = document.getElementById('profession').value.trim();
    const country = document.getElementById('country').value.trim();
    const site = document.getElementById('targetPlatform').value.trim();

    if (prof) parts.push(`"${prof}"`);
    if (country) parts.push(`"${country}"`);
    if (site) parts.push(`site:${site}`);

    return parts.join(' ') + ' ' + EMAIL_PROVIDERS.join(' OR ');
}

function updateQueryPreview() {
    const q = buildQuery();
    const el = document.getElementById('queryPreview');
    el.textContent = q || 'Start typing to build your query...';
    el.style.color = q ? 'var(--primary)' : 'var(--text-muted)';
}

// ============================================
// FORM SUBMISSION
// ============================================
async function handleSubmit(e) {
    e.preventDefault();

    const btn = document.getElementById('btnSubmit');
    const btnText = btn.querySelector('.btn-text');
    const spinner = btn.querySelector('.spinner');

    btn.disabled = true;
    btnText.textContent = 'Processing...';
    spinner.classList.remove('hidden');
    hideStatus();

    try {
        const categoryIdVal = document.getElementById('categoryId').value;
        const categoryName = document.getElementById('categorySearch').value.trim();
        const projectIdVal = document.getElementById('projectId').value;
        const projectName = document.getElementById('newProjectName').value.trim()
            || document.getElementById('projectSearch').value.trim();

        const profession = document.getElementById('profession').value.trim();
        if (!categoryName) throw new Error('Category is required');
        if (!projectName) throw new Error('Project is required');
        if (!profession) throw new Error('Profession / Niche is required');

        let categoryId = categoryIdVal ? parseInt(categoryIdVal) : null;

        if (!categoryId) {
            const newCat = await post('categories', { name: categoryName });
            categoryId = newCat[0].id;
            categories.push(newCat[0]);
            searchQueries = await get('search_queries', {
                select: 'id,category_id,search_engine,target_platform,country'
            });
        }

        let projectId = projectIdVal ? parseInt(projectIdVal) : null;

        if (!projectId) {
            const newProj = await post('projects', {
                name: projectName,
                category_id: categoryId
            });
            projectId = newProj[0].id;
            projects.push(newProj[0]);
        }

        const targetPlatform = document.getElementById('targetPlatform').value.trim() || null;
        const country = document.getElementById('country').value.trim() || null;
        const searchEngine = document.getElementById('searchEngine').value;
        const targetResults = parseInt(document.getElementById('targetResults').value);
        const searchQuery = buildQuery();

        const combo = checkComboStatus(categoryId, searchEngine, targetPlatform, country);

        if (combo.status === 'exhausted') {
            showStatus(
                `Combo fully used — this exact search was exhausted after page ${combo.lastPage}. Try changing profession, country, target website, or search engine.`,
                'error'
            );
            return;
        }

        const startPage = combo.status === 'resume' ? combo.lastPage + 1 : 1;
        const resumeMsg = combo.status === 'resume' ? ` (resuming from page ${startPage})` : '';

        let searchQueryId = combo.searchQueryId;

        if (!searchQueryId) {
            const newSq = await post('search_queries', {
                category_id: categoryId,
                search_engine: searchEngine,
                target_platform: targetPlatform,
                country: country
            });
            searchQueryId = newSq[0].id;
            searchQueries.push(newSq[0]);
        }

        const payload = {
            search_query_id: searchQueryId,
            project_id: projectId,
            category_id: categoryId,
            profession: profession,
            target_platform: targetPlatform,
            country: country,
            search_engine: searchEngine,
            target_results: targetResults,
            search_query: searchQuery,
            start_page: startPage,
            combo_status: combo.status
        };

        const n8nRes = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!n8nRes.ok) {
            const errText = await n8nRes.text();
            throw new Error(`n8n webhook failed: ${n8nRes.status} — ${errText}`);
        }

        const n8nData = await n8nRes.json();

        let msg = `Research launched!${resumeMsg}<br>
                   <strong>Query:</strong> <code>${esc(searchQuery)}</code><br>
                   <strong>Target:</strong> ${targetResults} emails<br>
                   <strong>Starting page:</strong> ${startPage}`;

        if (n8nData.emails_found !== undefined) {
            msg += `<br><strong>Found:</strong> ${n8nData.emails_found} emails`;
        }

        if (n8nData.warnings?.length > 0) {
            msg += `<br><br><strong>Duplicate warnings:</strong><br>`;
            n8nData.warnings.forEach(w => {
                msg += `* ${esc(w.email || w.phone)} — companies: ${esc(w.companies?.join(', ') || 'unknown')}<br>`;
            });
        }

        showStatus(msg, 'success');

        await loadSearchQueryRuns();

    } catch (err) {
        console.error('Submit error:', err);
        showStatus(`Error: ${esc(err.message)}`, 'error');
    } finally {
        btn.disabled = false;
        btnText.textContent = 'Start Research';
        spinner.classList.add('hidden');
    }
}

// ============================================
// UI HELPERS
// ============================================
function showStatus(html, type) {
    const el = document.getElementById('statusMessage');
    el.innerHTML = html;
    el.className = `status ${type}`;
    el.classList.remove('hidden');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideStatus() {
    document.getElementById('statusMessage').classList.add('hidden');
}
