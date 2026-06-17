/* ============================================================
   CGP Monitor V2 — application logic
   Veille & prospection des cabinets CGP (France).
   ============================================================ */
'use strict';

const APP_VERSION = '2.0.0';

/* localStorage keys (préfixe v2 pour ne pas heurter la V1) */
const LS = {
    STATUS:   'cgpv2_statuses',     // { [id]: { status, date } }
    FOLK:     'cgpv2_folk',         // { [id]: date }
    SYNC:     'cgpv2_sync_config',  // { gistId, token }
    FOLK_KEY: 'cgpv2_folk_api_key', // string
};

/* Libellés & titres des registres / associations */
const ASSOC_LABELS = { cncgp: 'CNCGP', cncef: 'CNCEF', anacofi: 'ANACOFI', affo: 'AFFO', ucgp: 'UCGP', orias: 'ORIAS' };
const ASSOC_TITLES = {
    cncgp: 'Chambre Nationale des Conseillers en Gestion de Patrimoine',
    cncef: 'Chambre Nationale des Conseils Experts Financiers',
    anacofi: 'Association Nationale des Conseils Financiers',
    affo: 'Association Francaise du Family Office',
    ucgp: 'Union des Conseils en Gestion de Patrimoine',
    orias: 'Registre officiel ORIAS',
};
/* Tags de bookkeeping — jamais affichés comme badge */
const ASSOC_HIDDEN = new Set(['registre', 'manuel', 'leaders_league']);
/* Priorité pour le comptage en UNE seule association */
const ASSOC_PRIORITY = ['cncgp', 'cncef', 'anacofi'];

const ACTIVITIES = ['CIF', 'COA', 'IOBSP', 'Immobilier'];

const STATUS_OPTS = [
    { v: '',         label: 'Statut' },
    { v: 'en_cours', label: 'En cours' },
    { v: 'contacte', label: 'Contacté' },
    { v: 'refus',    label: 'Refus' },
];
const STATUS_LABELS = { en_cours: 'En cours', contacte: 'Contacté', refus: 'Refus' };

const EXPERTISE_OPTIONS = [
    { v: 'assurance',    label: 'Assurance',                  match: ['assurance'] },
    { v: 'assurancevie', label: 'Assurance vie',              match: ['assurancevie'] },
    { v: 'credit',       label: 'Crédit',                     match: ['credit'] },
    { v: 'patrimoine',   label: 'Patrimoine / gestion privée', match: ['patrimoine', 'gestionpriv', 'gestiondepatrimoine'] },
    { v: 'immobilier',   label: 'Immobilier',                 match: ['immobilier'] },
    { v: 'retraite',     label: 'Retraite',                   match: ['retraite'] },
    { v: 'fiscalite',    label: 'Fiscalité',                  match: ['fiscal'] },
    { v: 'transmission', label: 'Transmission',               match: ['transmission', 'succession'] },
    { v: 'structured',   label: 'Produits structurés',        match: [] },  // via has_structured_products
];

const PAGE_SIZE = 50;

/* ============================================================
   ÉTAT GLOBAL
   ============================================================ */
let MEMBERS = [];          // population "consultable" (email | phone | website | dirigeants)
let GROUPEMENTS = null;    // groupements.json
let CARTO = null;          // cartographie json
let NEW_MEMBERS = null;    // new_members.json
let DATA_DATE = new Date();// date de référence (data.last_updated) pour la récence

let STATUS = {};           // cache en mémoire de LS.STATUS
let FOLK = {};             // cache en mémoire de LS.FOLK

let FILTERS = newFilters();
let FILTERED = [];         // résultat courant de l'Annuaire
let SHOWN = PAGE_SIZE;     // nb d'éléments rendus (pagination)

let saveTimer = null;
let isSyncing = false;

function newFilters() {
    return { search: '', assoc: '', dept: '', activity: '', status: '', groupement: '',
             creation: '', ca: '', aum: '', structure: '', expertise: '', folkOnly: false };
}

/* ============================================================
   UTILITAIRES
   ============================================================ */
function $(id) { return document.getElementById(id); }
function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function readLS(k, dflt) { try { return JSON.parse(localStorage.getItem(k)) || dflt; } catch { return dflt; } }
function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

/* Normalisation pour la recherche (accents retirés, casse basse, espaces gardés) */
function searchNorm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
/* Normalisation "slug" (alphanumérique uniquement) */
function slug(s) {
    return searchNorm(s).replace(/[^a-z0-9]/g, '');
}
function titleCase(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase());
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('fr-FR');
}
function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return `${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}
function fmtEur(n) {
    if (n == null) return '';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + ' Md€';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + ' M€';
    if (n >= 1e3) return Math.round(n / 1e3) + ' k€';
    return n + ' €';
}
function linkedinUrl(name, company) {
    const q = encodeURIComponent([name, company].filter(Boolean).join(' '));
    return `https://www.linkedin.com/search/results/people/?keywords=${q}`;
}
function websiteUrl(w) {
    if (!w) return '';
    return /^https?:\/\//i.test(w) ? w : 'https://' + w;
}

/* Association primaire (1 seul bucket) */
function primaryAssoc(m) {
    const a = m.associations || {};
    for (const k of ASSOC_PRIORITY) if (a[k]) return k;
    return 'other';
}
/* Badges visibles (registres réels, non masqués) */
function visibleAssocs(m) {
    const a = m.associations || {};
    const order = ['cncgp', 'cncef', 'anacofi', 'ucgp', 'affo', 'orias'];
    return order.filter(k => a[k] && !ASSOC_HIDDEN.has(k));
}

/* Dirigeants nettoyés (personnes physiques, pas de CAC, dédupliqués) */
function cleanDirectors(m) {
    const seen = new Set(), out = [];
    for (const d of (m.directors || [])) {
        const name = (d.name || '').trim();
        if (!name) continue;
        if (d.type && d.type !== 'personne physique') continue;
        if (/commissaire/i.test(d.role || '')) continue;
        if (name.replace(/\s+/g, '').length < 3) continue;
        const key = slug(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        let role = (d.role || '').trim();
        if (role.length < 2) role = 'Dirigeant';
        role = role.replace(/^Président de SAS$/i, 'Président').replace(/^Representant legal$/i, 'Représentant légal');
        out.push({ name: titleCase(name), role });
        if (out.length >= 6) break;
    }
    return out;
}

/* ============================================================
   RÉCENCE / FILTRES NUMÉRIQUES
   ============================================================ */
function windowStart(win, ref) {
    const d = new Date(ref);
    if (win === '7j') d.setDate(d.getDate() - 7);
    else if (win === '1mois') d.setMonth(d.getMonth() - 1);
    else if (win === '4mois') d.setMonth(d.getMonth() - 4);
    else if (win === '1an') d.setFullYear(d.getFullYear() - 1);
    else return null;
    return d;
}
function inCreationWindow(m, win) {
    const start = windowStart(win, DATA_DATE);
    if (!start) return true;
    if (!m.creation_date) return false;
    const cd = new Date(m.creation_date);
    if (isNaN(cd)) return false;
    return cd >= start && cd <= DATA_DATE;
}
function caInRange(m, range) {
    const ca = m.finances_data_gouv && m.finances_data_gouv.ca_eur;
    if (ca == null) return false;
    const [lo, hi] = range.split('-');
    if (lo && ca < +lo) return false;
    if (hi && ca >= +hi) return false;
    return true;
}
function aumInRange(m, range) {
    const aum = m.website_data && m.website_data.aum_eur;
    if (aum == null) return false;
    const [lo, hi] = range.split('-');
    if (lo && aum < +lo) return false;
    if (hi && aum >= +hi) return false;
    return true;
}
function hasExpertise(m, v) {
    if (v === 'structured') return !!(m.website_data && m.website_data.has_structured_products);
    const opt = EXPERTISE_OPTIONS.find(o => o.v === v);
    if (!opt) return false;
    const tags = [];
    (m.specialties || []).forEach(s => tags.push(slug(s)));
    if (m.website_data && m.website_data.expertises) m.website_data.expertises.forEach(s => tags.push(slug(s)));
    return tags.some(t => opt.match.some(mm => t.includes(mm)));
}

/* État statut / Folk */
function statusOf(id) { const e = STATUS[id]; return (e && e.status) || ''; }
function isFolk(id) { return !!FOLK[id]; }
function loadMaps() { STATUS = readLS(LS.STATUS, {}); FOLK = readLS(LS.FOLK, {}); }

function setStatus(id, val) {
    if (val) STATUS[id] = { status: val, date: todayISO() };
    else delete STATUS[id];
    writeLS(LS.STATUS, STATUS);
    afterMutation();
}
function toggleFolk(id, on) {
    if (on) FOLK[id] = todayISO();
    else delete FOLK[id];
    writeLS(LS.FOLK, FOLK);
    afterMutation();
}
function afterMutation() {
    scheduleCloudSave();
    updateStats();
    updateFolkIndicator();
    if (FILTERS.status || FILTERS.folkOnly) renderAnnuaire();
}

/* ============================================================
   CHARGEMENT DES DONNÉES
   ============================================================ */
async function loadData() {
    const bust = '?_=' + Date.now();
    const [mRes, nRes, gRes, cRes] = await Promise.all([
        // cache:'no-cache' -> revalidation serveur (ETag/304), pas de re-téléchargement complet
        fetch('data/members.json' + bust, { cache: 'no-cache' }).catch(() => null),
        fetch('data/new_members.json' + bust, { cache: 'no-cache' }).catch(() => null),
        fetch('data/groupements.json' + bust, { cache: 'no-cache' }).catch(() => null),
        fetch('data/20260413_cartographie_groupements_cgp.json' + bust, { cache: 'no-cache' }).catch(() => null),
    ]);

    if (mRes && mRes.ok) {
        const data = await mRes.json();
        if (data.last_updated) { const d = new Date(data.last_updated); if (!isNaN(d)) DATA_DATE = d; }
        const raw = data.members || [];
        // Population "consultable" : email OU téléphone OU site OU dirigeants
        MEMBERS = raw.filter(m => m.email || m.phone || m.website || (m.directors && m.directors.length));
        // Pré-calcul du champ de recherche
        for (const m of MEMBERS) {
            const dirs = (m.directors || []).map(d => d.name).join(' ');
            const a = m.address || {};
            m._hay = searchNorm([m.company_name, a.city, a.postal_code, m.siren, m.orias_number,
                                 m.email, m.groupement, dirs].filter(Boolean).join(' '));
        }
        $('lastUpdate').textContent = 'Mis à jour : ' + fmtDateTime(data.last_updated);
        $('lastUpdate').title = 'App v' + APP_VERSION;
    } else {
        $('lastUpdate').textContent = 'Erreur de chargement des données';
    }
    if (nRes && nRes.ok) NEW_MEMBERS = await nRes.json();
    if (gRes && gRes.ok) GROUPEMENTS = await gRes.json();
    if (cRes && cRes.ok) CARTO = await cRes.json();
}

/* ============================================================
   STATISTIQUES (7 tuiles) — population consultable
   ============================================================ */
function computeStats() {
    let total = MEMBERS.length, new7 = 0, new120 = 0, enCours = 0, contacte = 0, refus = 0, folk = 0;
    for (const m of MEMBERS) {
        if (inCreationWindow(m, '7j')) new7++;
        if (inCreationWindow(m, '4mois')) new120++;
        const st = statusOf(m.id);
        if (st === 'en_cours') enCours++;
        else if (st === 'contacte') contacte++;
        else if (st === 'refus') refus++;
        if (isFolk(m.id)) folk++;
    }
    return { total, new7, new120, en_cours: enCours, contacte, refus, folk };
}
function updateStats() {
    const s = computeStats();
    $('stat-total').textContent = s.total.toLocaleString('fr-FR');
    $('stat-new7').textContent = s.new7.toLocaleString('fr-FR');
    $('stat-new120').textContent = s.new120.toLocaleString('fr-FR');
    $('stat-en_cours').textContent = s.en_cours.toLocaleString('fr-FR');
    $('stat-contacte').textContent = s.contacte.toLocaleString('fr-FR');
    $('stat-refus').textContent = s.refus.toLocaleString('fr-FR');
    $('stat-folk').textContent = s.folk.toLocaleString('fr-FR');
}

/* ============================================================
   ONGLETS
   ============================================================ */
function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'acteurs' && CARTO) renderActeurs();
    if (name === 'groupements' && GROUPEMENTS) renderGroupements();
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function renderDashboard() {
    // 4 cartes association (bucket unique, somme = total)
    const buckets = { cncgp: 0, cncef: 0, anacofi: 0, other: 0 };
    for (const m of MEMBERS) buckets[primaryAssoc(m)]++;
    const cards = [
        { key: 'cncgp',   name: 'CNCGP',          desc: ASSOC_TITLES.cncgp,   color: 'var(--blue)' },
        { key: 'cncef',   name: 'CNCEF',          desc: ASSOC_TITLES.cncef,   color: 'var(--green)' },
        { key: 'anacofi', name: 'ANACOFI',        desc: ASSOC_TITLES.anacofi, color: '#b5740f' },
        { key: 'other',   name: 'Hors association', desc: 'Cabinets sans adhésion CNCGP / CNCEF / ANACOFI', color: 'var(--text-muted)' },
    ];
    $('assocCards').innerHTML = cards.map(c => `
        <div class="assoc-card" style="--tile-color:${c.color}" data-assoc="${c.key}">
            <div class="ac-value">${buckets[c.key].toLocaleString('fr-FR')}</div>
            <div class="ac-name">${escHtml(c.name)}</div>
            <div class="ac-desc">${escHtml(c.desc)}</div>
        </div>`).join('');

    // Derniers nouveaux CGP détectés
    const list = (NEW_MEMBERS && NEW_MEMBERS.new_members) || [];
    if (!list.length) {
        $('newMembersList').innerHTML = `<div class="empty"><div class="em-icon">🗂️</div>Aucun nouveau cabinet récent.</div>`;
    } else {
        $('newMembersList').innerHTML = list.slice(0, 20).map(n => {
            const assoc = (n.associations || []).filter(a => !ASSOC_HIDDEN.has(a))
                .map(a => `<span class="badge badge-${a}">${ASSOC_LABELS[a] || a.toUpperCase()}</span>`).join(' ');
            const acts = (n.activities || []).join(', ');
            return `<div class="new-item">
                <div>
                    <div class="ni-name">${escHtml(n.company_name || '—')}</div>
                    <div class="ni-meta">${escHtml([n.city, n.department].filter(Boolean).join(' · '))}${acts ? ' · ' + escHtml(acts) : ''} ${assoc}</div>
                </div>
                <div class="ni-date">${escHtml(fmtDate(n.first_seen))}</div>
            </div>`;
        }).join('');
    }
}

/* ============================================================
   ANNUAIRE
   ============================================================ */
function populateAnnuaireFilters() {
    // Départements
    const deptMap = {};
    for (const m of MEMBERS) {
        const a = m.address || {};
        if (a.department) deptMap[a.department] = a.department_name || '';
    }
    const deptOpts = ['<option value="">Tous</option>'].concat(
        Object.keys(deptMap).sort().map(d => `<option value="${escHtml(d)}">${escHtml(d)}${deptMap[d] ? ' — ' + escHtml(deptMap[d]) : ''}</option>`));
    $('f-dept').innerHTML = deptOpts.join('');

    // Groupements
    const grp = new Set();
    for (const m of MEMBERS) if (m.groupement) grp.add(m.groupement);
    const grpOpts = ['<option value="">Tous</option>'].concat(
        [...grp].sort((a, b) => a.localeCompare(b, 'fr')).map(g => `<option value="${escHtml(g)}">${escHtml(g)}</option>`));
    $('f-groupement').innerHTML = grpOpts.join('');

    // Expertises
    $('f-expertise').innerHTML = ['<option value="">Toutes</option>'].concat(
        EXPERTISE_OPTIONS.map(o => `<option value="${o.v}">${escHtml(o.label)}</option>`)).join('');
}

function readFiltersFromUI() {
    FILTERS.assoc = $('f-assoc').value;
    FILTERS.dept = $('f-dept').value;
    FILTERS.activity = $('f-activity').value;
    FILTERS.status = $('f-status').value;
    FILTERS.groupement = $('f-groupement').value;
    FILTERS.creation = $('f-creation').value;
    FILTERS.ca = $('f-ca').value;
    FILTERS.aum = $('f-aum').value;
    FILTERS.structure = $('f-structure').value;
    FILTERS.expertise = $('f-expertise').value;
}
function syncFiltersToUI() {
    $('f-assoc').value = FILTERS.assoc;
    $('f-dept').value = FILTERS.dept;
    $('f-activity').value = FILTERS.activity;
    $('f-status').value = FILTERS.status;
    $('f-groupement').value = FILTERS.groupement;
    $('f-creation').value = FILTERS.creation;
    $('f-ca').value = FILTERS.ca;
    $('f-aum').value = FILTERS.aum;
    $('f-structure').value = FILTERS.structure;
    $('f-expertise').value = FILTERS.expertise;
}

function byCreationDesc(a, b) {
    const da = a.creation_date, db = b.creation_date;
    if (da && db) return da < db ? 1 : da > db ? -1 : 0;
    if (da && !db) return -1;
    if (!da && db) return 1;
    return 0;
}

function getFiltered() {
    let arr = MEMBERS;
    const f = FILTERS;
    if (f.search) {
        const toks = searchNorm(f.search).split(/\s+/).filter(Boolean);
        arr = arr.filter(m => toks.every(t => m._hay.includes(t)));
    }
    if (f.assoc) arr = arr.filter(m => primaryAssoc(m) === f.assoc);
    if (f.dept) arr = arr.filter(m => (m.address && m.address.department) === f.dept);
    if (f.activity) arr = arr.filter(m => (m.activities || []).includes(f.activity));
    if (f.status === 'none') arr = arr.filter(m => !statusOf(m.id));
    else if (f.status) arr = arr.filter(m => statusOf(m.id) === f.status);
    if (f.groupement) arr = arr.filter(m => m.groupement === f.groupement);
    if (f.creation) arr = arr.filter(m => inCreationWindow(m, f.creation));
    if (f.ca) arr = arr.filter(m => caInRange(m, f.ca));
    if (f.aum) arr = arr.filter(m => aumInRange(m, f.aum));
    if (f.structure) arr = arr.filter(m => (m.finances_data_gouv && m.finances_data_gouv.categorie_entreprise) === f.structure);
    if (f.expertise) arr = arr.filter(m => hasExpertise(m, f.expertise));
    if (f.folkOnly) arr = arr.filter(m => isFolk(m.id));
    return arr.slice().sort(byCreationDesc);
}

function firmCardHtml(m) {
    const badges = visibleAssocs(m)
        .map(k => `<span class="badge badge-${k}" title="${escHtml(ASSOC_TITLES[k] || '')}">${ASSOC_LABELS[k]}</span>`).join(' ');
    const a = m.address || {};
    const addr = [a.street, [a.postal_code, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const dirs = cleanDirectors(m).map(d =>
        `<span class="director-chip"><a href="${linkedinUrl(d.name, m.company_name)}" target="_blank" rel="noopener" title="Rechercher sur LinkedIn">${escHtml(d.name)}</a> <span class="role">· ${escHtml(d.role)}</span></span>`).join('');
    const fin = m.finances_data_gouv || {};
    const ca = fin.ca_eur != null ? `<div class="firm-row"><span class="ico">€</span><span>CA ${escHtml(fmtEur(fin.ca_eur))}${fin.year ? ' (' + fin.year + ')' : ''}</span></div>` : '';
    const aum = (m.website_data && m.website_data.aum_eur != null) ? `<div class="firm-row"><span class="ico">∑</span><span>Encours ${escHtml(fmtEur(m.website_data.aum_eur))}</span></div>` : '';
    const st = statusOf(m.id);
    const folkOn = isFolk(m.id);
    const detected = m.first_seen ? `<span class="firm-detected">Détecté le ${escHtml(fmtDate(m.first_seen))}</span>` : '';

    return `<div class="firm-card" data-id="${escHtml(m.id)}">
        <div class="firm-head">
            <div>
                <div class="firm-name">${escHtml(m.company_name || '—')}</div>
                <div class="firm-badges">${badges}
                    ${m.groupement ? `<span class="badge badge-tier" title="Groupement / réseau">${escHtml(m.groupement)}</span>` : ''}
                </div>
            </div>
        </div>
        <div class="firm-grid">
            ${addr ? `<div class="firm-row"><span class="ico">📍</span><span>${escHtml(addr)}</span></div>` : ''}
            ${m.siren ? `<div class="firm-row"><span class="ico">#</span><span>SIREN ${escHtml(m.siren)}</span></div>` : ''}
            ${m.creation_date ? `<div class="firm-row"><span class="ico">📅</span><span>Créé le ${escHtml(fmtDate(m.creation_date))}</span></div>` : ''}
            ${m.phone ? `<div class="firm-row"><span class="ico">☎</span><a href="tel:${escHtml(m.phone)}">${escHtml(m.phone)}</a></div>` : ''}
            ${m.email ? `<div class="firm-row"><span class="ico">✉</span><a href="mailto:${escHtml(m.email)}">${escHtml(m.email)}</a></div>` : ''}
            ${m.website ? `<div class="firm-row"><span class="ico">🌐</span><a href="${escHtml(websiteUrl(m.website))}" target="_blank" rel="noopener">${escHtml(m.website)}</a></div>` : ''}
            ${ca}${aum}
        </div>
        ${dirs ? `<div class="directors">${dirs}</div>` : ''}
        <div class="firm-foot">
            <select class="status-select status-${st}" data-id="${escHtml(m.id)}">
                ${STATUS_OPTS.map(o => `<option value="${o.v}" ${o.v === st ? 'selected' : ''}>${o.label}</option>`).join('')}
            </select>
            <label class="folk-toggle ${folkOn ? 'on' : ''}">
                <input type="checkbox" data-id="${escHtml(m.id)}" ${folkOn ? 'checked' : ''}>
                <span class="folk-switch"></span> Folk
            </label>
            ${detected}
        </div>
    </div>`;
}

function renderAnnuaire() {
    FILTERED = getFiltered();
    SHOWN = Math.min(SHOWN, Math.max(PAGE_SIZE, SHOWN));
    if (SHOWN > FILTERED.length) SHOWN = Math.max(PAGE_SIZE, FILTERED.length);
    $('resultsCount').textContent = FILTERED.length.toLocaleString('fr-FR');
    if (!FILTERED.length) {
        $('resultsList').innerHTML = `<div class="empty"><div class="em-icon">🔍</div>Aucun cabinet ne correspond à ces critères.</div>`;
        $('loadMoreBtn').style.display = 'none';
        return;
    }
    const slice = FILTERED.slice(0, SHOWN);
    $('resultsList').innerHTML = slice.map(firmCardHtml).join('');
    $('loadMoreBtn').style.display = SHOWN < FILTERED.length ? '' : 'none';
    $('loadMoreBtn').textContent = `Charger plus (${(FILTERED.length - SHOWN).toLocaleString('fr-FR')} restants)`;
    updateActiveFilterNote();
}
function loadMore() { SHOWN += PAGE_SIZE; renderAnnuaire(); }

function updateActiveFilterNote() {
    const notes = [];
    if (FILTERS.folkOnly) notes.push('Marqués Folk');
    if (FILTERS.status && FILTERS.status !== 'none') notes.push(STATUS_LABELS[FILTERS.status] || FILTERS.status);
    if (FILTERS.creation) notes.push('Créés ' + ({ '7j': '< 7j', '1mois': '< 1 mois', '4mois': '< 4 mois', '1an': '< 1 an' }[FILTERS.creation] || ''));
    $('activeFilterNote').textContent = notes.length ? '· Filtre : ' + notes.join(' · ') : '';
}

function resetFilters() {
    FILTERS = newFilters();
    syncFiltersToUI();
    $('searchInput').value = '';
    SHOWN = PAGE_SIZE;
    clearActiveTiles();
    renderAnnuaire();
}

/* Clic sur une tuile -> filtre l'Annuaire (reset puis applique) */
function applyTileFilter(stat) {
    FILTERS = newFilters();
    if (stat === 'new7') FILTERS.creation = '7j';
    else if (stat === 'new120') FILTERS.creation = '4mois';
    else if (stat === 'en_cours' || stat === 'contacte' || stat === 'refus') FILTERS.status = stat;
    else if (stat === 'folk') FILTERS.folkOnly = true;
    // 'total' -> aucun filtre
    syncFiltersToUI();
    $('searchInput').value = '';
    SHOWN = PAGE_SIZE;
    setActiveTile(stat);
    switchTab('annuaire');
    renderAnnuaire();
}
function setActiveTile(stat) {
    document.querySelectorAll('.stat-tile').forEach(t => t.classList.toggle('active', t.dataset.stat === stat));
}
function clearActiveTiles() { document.querySelectorAll('.stat-tile').forEach(t => t.classList.remove('active')); }

/* Clic sur une carte association du dashboard */
function applyAssocFilter(key) {
    FILTERS = newFilters();
    FILTERS.assoc = key;
    syncFiltersToUI();
    $('searchInput').value = '';
    SHOWN = PAGE_SIZE;
    clearActiveTiles();
    switchTab('annuaire');
    renderAnnuaire();
}

/* ============================================================
   ACTEURS (cartographie)
   ============================================================ */
function pertClass(p) {
    const t = (p || '').toUpperCase();
    if (t.startsWith('TRÈS HAUTE') || t.startsWith('TRES HAUTE')) return 'badge-tres-haute';
    if (t.startsWith('HAUTE')) return 'badge-haute';
    if (t.startsWith('MOYENNE')) return 'badge-moyenne';
    return 'badge';
}
function pertLabel(p) {
    const m = (p || '').match(/^(TRÈS HAUTE|TRES HAUTE|HAUTE|MOYENNE|BASSE|FAIBLE)/i);
    return m ? m[0] : '';
}
function entityIdMap() {
    const map = {};
    if (!CARTO) return map;
    for (const cat of CARTO.categories) for (const e of cat.entites) map[e.id] = e.nom;
    const pd = CARTO.plateformes_distribution;
    if (pd && pd.acteurs) for (const a of pd.acteurs) map[slug(a.nom)] = a.nom;
    return map;
}
/* Comptage des cabinets de la base par groupement (normalisé) */
let GROUP_COUNTS = null;
function groupCounts() {
    if (GROUP_COUNTS) return GROUP_COUNTS;
    GROUP_COUNTS = {};
    for (const m of MEMBERS) if (m.groupement) {
        const k = slug(m.groupement);
        GROUP_COUNTS[k] = (GROUP_COUNTS[k] || 0) + 1;
    }
    return GROUP_COUNTS;
}
function baseCountFor(name) {
    const counts = groupCounts();
    const target = slug(name);
    if (!target) return 0;
    let total = 0;
    for (const [k, v] of Object.entries(counts)) {
        if (k === target || k.includes(target) || target.includes(k)) total += v;
    }
    return total;
}

function entityCardHtml(e) {
    const stats = [];
    if (e.cabinets != null) stats.push(`<div class="entity-stat"><div class="es-val">${e.cabinets.toLocaleString('fr-FR')}</div><div class="es-lbl">cabinets</div></div>`);
    if (e.conseillers != null) stats.push(`<div class="entity-stat"><div class="es-val">${e.conseillers.toLocaleString('fr-FR')}</div><div class="es-lbl">conseillers</div></div>`);
    if (e.encours_mds != null) stats.push(`<div class="entity-stat"><div class="es-val">${e.encours_mds} Md€</div><div class="es-lbl">encours</div></div>`);
    if (e.fondation) stats.push(`<div class="entity-stat"><div class="es-val">${e.fondation}</div><div class="es-lbl">fondation</div></div>`);
    const pert = e.pertinence_cmf ? `<span class="badge ${pertClass(e.pertinence_cmf)}">${escHtml(pertLabel(e.pertinence_cmf))}</span>` : '';
    const bc = baseCountFor(e.nom);
    return `<div class="entity-card">
        <div class="entity-head">
            <div><div class="entity-name">${escHtml(e.nom)}</div>${e.nom_complet ? `<div class="entity-full">${escHtml(e.nom_complet)}</div>` : ''}</div>
            ${pert}
        </div>
        ${stats.length ? `<div class="entity-stats">${stats.join('')}</div>` : ''}
        ${e.president ? `<div class="entity-row"><b>Président :</b> ${escHtml(e.president)}${e.cabinet_president ? ' (' + escHtml(e.cabinet_president) + ')' : ''}</div>` : ''}
        ${e.contact_cle && e.contact_cle !== e.president ? `<div class="entity-row"><b>Contact clé :</b> ${escHtml(e.contact_cle)}</div>` : ''}
        ${e.evenement_annuel ? `<div class="entity-row"><b>Événement :</b> ${escHtml(e.evenement_annuel)}</div>` : ''}
        ${e.notes ? `<div class="entity-notes">${escHtml(e.notes)}</div>` : ''}
        <div class="entity-foot">
            ${e.site ? `<a href="${escHtml(websiteUrl(e.site))}" target="_blank" rel="noopener">${escHtml(e.site.replace(/^https?:\/\//, ''))}</a>` : '<span></span>'}
            ${bc > 0 ? `<span class="base-count">${bc.toLocaleString('fr-FR')} dans la base</span>` : ''}
        </div>
    </div>`;
}
function plateformeCardHtml(a) {
    const pert = a.pertinence_cmf ? `<span class="badge ${pertClass(a.pertinence_cmf)}">${escHtml(pertLabel(a.pertinence_cmf))}</span>` : '';
    return `<div class="entity-card">
        <div class="entity-head">
            <div><div class="entity-name">${escHtml(a.nom)}</div>${a.groupe ? `<div class="entity-full">${escHtml(a.groupe)}</div>` : ''}</div>
            ${pert}
        </div>
        ${a.description ? `<div class="entity-notes">${escHtml(a.description)}</div>` : ''}
        ${a.pertinence_cmf ? `<div class="entity-row">${escHtml(a.pertinence_cmf)}</div>` : ''}
        <div class="entity-foot">${a.site ? `<a href="${escHtml(websiteUrl(a.site))}" target="_blank" rel="noopener">${escHtml(a.site.replace(/^https?:\/\//, ''))}</a>` : ''}</div>
    </div>`;
}

function renderActeurs() {
    if (!CARTO) { $('acteursContent').innerHTML = `<div class="empty">Cartographie indisponible.</div>`; return; }
    // Remplir le filtre catégorie une fois
    const catSel = $('f-acteur-cat');
    if (catSel.options.length <= 1) {
        catSel.innerHTML = '<option value="">Toutes</option>' +
            CARTO.categories.map(c => `<option value="${escHtml(c.id)}">${escHtml(c.label)}</option>`).join('') +
            '<option value="plateformes">Plateformes de distribution</option>';
    }
    const q = searchNorm($('acteursSearch').value);
    const fCat = $('f-acteur-cat').value;
    const fPert = $('f-acteur-pert').value;
    const matchE = e => {
        if (q && !searchNorm([e.nom, e.nom_complet, e.notes, e.pertinence_cmf, e.president, e.contact_cle].filter(Boolean).join(' ')).includes(q)) return false;
        if (fPert && !(pertLabel(e.pertinence_cmf) || '').toUpperCase().startsWith(fPert.split(' ')[0])) return false;
        return true;
    };

    let html = '';
    // Bannière priorités CMF
    const prio = CARTO.priorites_prospection_cmf;
    if (prio && !q && !fCat && !fPert) {
        const idMap = entityIdMap();
        const chip = id => `<span class="chip">${escHtml(idMap[id] || idMap[slug(id)] || titleCase(id.replace(/_/g, ' ')))}</span>`;
        html += `<div class="priority-banner">
            <h3>Priorités de prospection CMF</h3>
            ${prio.rationale ? `<div class="pb-rationale">${escHtml(prio.rationale)}</div>` : ''}
            <div class="tier-row"><span class="tier-label tier-1">Tier 1 · Contact immédiat</span>${(prio.tier1_contact_immediat || []).map(chip).join('')}</div>
            <div class="tier-row"><span class="tier-label tier-2">Tier 2 · Moyen terme</span>${(prio.tier2_moyen_terme || []).map(chip).join('')}</div>
            <div class="tier-row"><span class="tier-label tier-3">Tier 3 · Veille</span>${(prio.tier3_veille || []).map(chip).join('')}</div>
        </div>`;
    }

    for (const cat of CARTO.categories) {
        if (fCat && fCat !== cat.id) continue;
        const ents = cat.entites.filter(matchE);
        if (!ents.length) continue;
        html += `<div class="cat-section">
            <div class="cat-header"><span class="cat-dot" style="background:${escHtml(cat.couleur || '#999')}"></span>
                <h3>${escHtml(cat.label)}</h3><span class="cat-count">${ents.length}</span></div>
            <div class="entity-grid">${ents.map(entityCardHtml).join('')}</div></div>`;
    }

    // Plateformes de distribution
    const pd = CARTO.plateformes_distribution;
    if (pd && pd.acteurs && (!fCat || fCat === 'plateformes')) {
        const acts = pd.acteurs.filter(a => {
            if (q && !searchNorm([a.nom, a.groupe, a.description, a.pertinence_cmf].filter(Boolean).join(' ')).includes(q)) return false;
            if (fPert && !(pertLabel(a.pertinence_cmf) || '').toUpperCase().startsWith(fPert.split(' ')[0])) return false;
            return true;
        });
        if (acts.length) {
            html += `<div class="cat-section">
                <div class="cat-header"><span class="cat-dot" style="background:#444"></span>
                    <h3>Plateformes de distribution</h3><span class="cat-count">${acts.length}</span></div>
                ${pd.description ? `<p class="section-sub">${escHtml(pd.description)}</p>` : ''}
                <div class="entity-grid">${acts.map(plateformeCardHtml).join('')}</div></div>`;
        }
    }

    $('acteursContent').innerHTML = html || `<div class="empty"><div class="em-icon">🔍</div>Aucune entité ne correspond.</div>`;
}

/* ============================================================
   GROUPEMENTS (fiches de référence)
   ============================================================ */
const GROUP_TYPE_LABELS = {
    ucgp: 'Réseaux UCGP', leaders_league: 'Réseaux & consolidateurs',
    plateforme: 'Plateformes de distribution', assureur: 'Assureurs / partenaires',
};
function renderGroupements() {
    if (!GROUPEMENTS) { $('groupementsContent').innerHTML = `<div class="empty">Données indisponibles.</div>`; return; }
    const typeSel = $('f-group-type');
    if (typeSel.options.length <= 1) {
        const types = [...new Set((GROUPEMENTS.groupements || []).map(g => g.type))];
        typeSel.innerHTML = '<option value="">Tous</option>' +
            types.map(t => `<option value="${escHtml(t)}">${escHtml(GROUP_TYPE_LABELS[t] || t)}</option>`).join('');
    }
    const q = searchNorm($('groupementsSearch').value);
    const fType = $('f-group-type').value;
    let html = '';

    // Bloc associations (référence)
    if (GROUPEMENTS.associations && !fType) {
        const assocs = GROUPEMENTS.associations.filter(a => !q || searchNorm([a.name, a.full_name, a.description].filter(Boolean).join(' ')).includes(q));
        if (assocs.length) {
            html += `<div class="cat-section">
                <div class="cat-header"><span class="cat-dot" style="background:var(--red)"></span><h3>Associations professionnelles</h3><span class="cat-count">${assocs.length}</span></div>
                <div class="entity-grid">${assocs.map(a => `<div class="entity-card">
                    <div class="entity-head"><div><div class="entity-name">${escHtml(a.name)}</div>${a.full_name ? `<div class="entity-full">${escHtml(a.full_name)}</div>` : ''}</div></div>
                    ${a.members_approx ? `<div class="entity-stats"><div class="entity-stat"><div class="es-val">${a.members_approx.toLocaleString('fr-FR')}</div><div class="es-lbl">adhérents (approx.)</div></div></div>` : ''}
                    ${a.description ? `<div class="entity-notes">${escHtml(a.description)}</div>` : ''}
                    <div class="entity-foot">${a.website ? `<a href="${escHtml(websiteUrl(a.website))}" target="_blank" rel="noopener">${escHtml(a.website.replace(/^https?:\/\//, ''))}</a>` : ''}</div>
                </div>`).join('')}</div></div>`;
        }
    }

    // Groupements par type
    const byType = {};
    for (const g of (GROUPEMENTS.groupements || [])) {
        if (fType && g.type !== fType) continue;
        if (q && !searchNorm([g.name, g.description, g.type].filter(Boolean).join(' ')).includes(q)) continue;
        (byType[g.type] = byType[g.type] || []).push(g);
    }
    for (const [type, list] of Object.entries(byType)) {
        html += `<div class="cat-section">
            <div class="cat-header"><span class="cat-dot" style="background:var(--violet)"></span><h3>${escHtml(GROUP_TYPE_LABELS[type] || type)}</h3><span class="cat-count">${list.length}</span></div>
            <div class="entity-grid">${list.map(g => {
                const bc = baseCountFor(g.name);
                return `<div class="entity-card">
                    <div class="entity-head"><div class="entity-name">${escHtml(g.name)}</div>${g.tier ? `<span class="badge badge-tier">${escHtml(g.tier)}</span>` : ''}</div>
                    ${g.description ? `<div class="entity-notes">${escHtml(g.description)}</div>` : ''}
                    <div class="entity-foot">
                        ${g.website ? `<a href="${escHtml(websiteUrl(g.website))}" target="_blank" rel="noopener">${escHtml(g.website.replace(/^https?:\/\//, ''))}</a>` : '<span></span>'}
                        ${bc > 0 ? `<span class="base-count">${bc.toLocaleString('fr-FR')} dans la base</span>` : ''}
                    </div></div>`;
            }).join('')}</div></div>`;
    }

    $('groupementsContent').innerHTML = html || `<div class="empty"><div class="em-icon">🔍</div>Aucun groupement ne correspond.</div>`;
}

/* ============================================================
   CLOUD SYNC (GitHub Gist)
   ============================================================ */
function getSyncConfig() { return readLS(LS.SYNC, {}); }
function setSyncStatus(status, detail) {
    const el = $('syncStatus'), dot = $('syncDot');
    const states = {
        syncing: { t: 'Sync…',  c: 'var(--orange)' },
        synced:  { t: 'Synchro', c: 'var(--green)' },
        error:   { t: 'Erreur', c: 'var(--alert-red)' },
        offline: { t: 'Local',  c: 'var(--text-muted)' },
    };
    const s = states[status] || states.offline;
    if (el) el.textContent = detail || s.t;
    if (dot) dot.style.background = s.c;
}
async function cloudLoad() {
    const { gistId, token } = getSyncConfig();
    if (!gistId) { setSyncStatus('offline'); return; }
    try {
        setSyncStatus('syncing');
        const headers = { 'Accept': 'application/vnd.github+json' };
        if (token) headers['Authorization'] = 'token ' + token;
        const resp = await fetch('https://api.github.com/gists/' + gistId, { headers });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const gist = await resp.json();
        const content = gist.files && gist.files['cgp-monitor-state.json'] && gist.files['cgp-monitor-state.json'].content;
        if (!content) { setSyncStatus('synced', 'Cloud vide'); return; }
        const cloud = JSON.parse(content);
        // Le local gagne en cas de conflit (merge non destructif)
        const mergedStatus = Object.assign({}, cloud.status || {}, readLS(LS.STATUS, {}));
        const mergedFolk = Object.assign({}, cloud.folk || {}, readLS(LS.FOLK, {}));
        writeLS(LS.STATUS, mergedStatus); writeLS(LS.FOLK, mergedFolk);
        loadMaps();
        updateStats(); updateFolkIndicator();
        if (document.querySelector('#tab-annuaire.active')) renderAnnuaire();
        setSyncStatus('synced');
    } catch (e) { console.warn('Cloud load failed', e); setSyncStatus('error'); }
}
function scheduleCloudSave() { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(cloudSave, 900); }
async function cloudSave() {
    const { gistId, token } = getSyncConfig();
    if (!gistId || !token || isSyncing) { if (!gistId) setSyncStatus('offline'); return; }
    isSyncing = true;
    try {
        setSyncStatus('syncing');
        const payload = JSON.stringify({ status: STATUS, folk: FOLK, last_sync: new Date().toISOString() }, null, 2);
        const resp = await fetch('https://api.github.com/gists/' + gistId, {
            method: 'PATCH',
            headers: { 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'Authorization': 'token ' + token },
            body: JSON.stringify({ files: { 'cgp-monitor-state.json': { content: payload } } }),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        setSyncStatus('synced');
    } catch (e) { console.warn('Cloud save failed', e); setSyncStatus('error'); }
    finally { isSyncing = false; }
}
function openSyncSettings() {
    const { gistId, token } = getSyncConfig();
    $('syncGistId').value = gistId || '';
    $('syncToken').value = token || '';
    openModal('syncModal');
}
function saveSyncSettings() {
    const gistId = $('syncGistId').value.trim();
    const token = $('syncToken').value.trim();
    writeLS(LS.SYNC, { gistId, token });
    closeModal('syncModal');
    cloudLoad();
}
function clearSyncSettings() { localStorage.removeItem(LS.SYNC); $('syncGistId').value = ''; $('syncToken').value = ''; setSyncStatus('offline'); }

/* ============================================================
   FOLK
   ============================================================ */
function getFolkApiKey() { return localStorage.getItem(LS.FOLK_KEY) || ''; }
function updateFolkIndicator() {
    const n = Object.keys(FOLK).length;
    const hasKey = !!getFolkApiKey();
    const el = $('folkStatus'), dot = $('folkDot');
    el.textContent = hasKey ? `Folk ✓ (${n})` : (n ? `Folk (${n})` : 'Folk Off');
    dot.style.background = hasKey ? 'var(--violet)' : 'var(--text-muted)';
}
function openFolkSettings() { $('folkApiKeyInput').value = getFolkApiKey(); openModal('folkModal'); }
function saveFolkSettings() { localStorage.setItem(LS.FOLK_KEY, $('folkApiKeyInput').value.trim()); closeModal('folkModal'); updateFolkIndicator(); }
function clearFolkSettings() { localStorage.removeItem(LS.FOLK_KEY); $('folkApiKeyInput').value = ''; updateFolkIndicator(); }

/* Bouton "Push Folk" : prépare folk_push.json + explique l'envoi serveur */
function pushFolk() {
    const ids = Object.keys(FOLK);
    if (!ids.length) {
        alert('Aucun cabinet marqué Folk.\n\nActivez le toggle « Folk » sur les fiches à synchroniser, puis revenez ici.');
        return;
    }
    // Télécharge le fichier folk_push.json à committer dans docs/data/
    downloadBlob(JSON.stringify(ids, null, 2), 'folk_push.json', 'application/json');
    alert(
        `${ids.length} cabinet(s) marqué(s) Folk.\n\n` +
        `Le navigateur ne peut pas appeler l'API Folk directement (CORS).\n` +
        `L'envoi se fait côté serveur via le workflow GitHub « folk-push.yml ».\n\n` +
        `Étapes :\n` +
        `1. Le fichier folk_push.json vient d'être téléchargé.\n` +
        `2. Placez-le dans docs/data/ et committez-le.\n` +
        `3. Lancez le workflow « Push to Folk CRM » avec votre clé API Folk.\n\n` +
        `(Ou demandez simplement « push folk » pour que je lance l'envoi.)`
    );
}

/* ============================================================
   EXPORT CSV (résultats filtrés, format Folk, UTF-8 BOM)
   ============================================================ */
const FOLK_COLUMNS = ['First Name', 'Last Name', 'Job Title', 'Company', 'Email', 'Phone', 'Address', 'City', 'Postal Code', 'Website', 'Notes'];
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exportCsv() {
    const rows = getFiltered();
    if (!rows.length) { alert('Aucun résultat à exporter avec les filtres actuels.'); return; }
    const lines = [FOLK_COLUMNS.join(',')];
    for (const m of rows) {
        const a = m.address || {};
        const dirs = cleanDirectors(m);
        const list = dirs.length ? dirs : [{ name: '', role: 'Dirigeant' }];
        for (const d of list) {
            const parts = (d.name || '').split(' ');
            const first = parts.shift() || '';
            const last = parts.join(' ');
            const assoc = visibleAssocs(m).map(k => ASSOC_LABELS[k]).join(', ');
            const notes = [
                assoc && 'Associations: ' + assoc,
                (m.activities || []).length && 'Activites: ' + m.activities.join(', '),
                m.groupement && 'Groupement: ' + m.groupement,
                m.orias_number && 'ORIAS: ' + m.orias_number,
                m.siren && 'SIREN: ' + m.siren,
                m.first_seen && 'Detecte: ' + m.first_seen,
                'Source: CGP Monitor',
            ].filter(Boolean).join(' | ');
            lines.push([first, last, d.role || 'Dirigeant', m.company_name || '', m.email || '', m.phone || '',
                        a.street || '', a.city || '', a.postal_code || '', m.website || '', notes].map(csvCell).join(','));
        }
    }
    downloadBlob('﻿' + lines.join('\r\n'), `cgp_export_${todayISO()}.csv`, 'text/csv;charset=utf-8');
}
function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================================================
   BOUTON MAJ (cache-bust)
   ============================================================ */
async function refreshData() {
    const btn = $('majBtn');
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
    try {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
        }
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
        }
    } catch (e) { console.warn('cache clear failed', e); }
    try { sessionStorage.setItem('cgpMajClicked', '1'); } catch {}
    const base = location.origin + location.pathname;
    location.replace(base + '?_=' + Date.now());
}

/* ============================================================
   MODALS
   ============================================================ */
function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

/* ============================================================
   ÉVÉNEMENTS
   ============================================================ */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function wireEvents() {
    // Onglets
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    // Tuiles stats
    document.querySelectorAll('.stat-tile').forEach(t => t.addEventListener('click', () => applyTileFilter(t.dataset.stat)));
    // Cartes association (dashboard) — délégation
    $('assocCards').addEventListener('click', e => {
        const card = e.target.closest('.assoc-card');
        if (card) applyAssocFilter(card.dataset.assoc);
    });

    // Recherche annuaire
    $('searchInput').addEventListener('input', debounce(e => {
        FILTERS.search = e.target.value; SHOWN = PAGE_SIZE; clearActiveTiles(); renderAnnuaire();
    }, 200));
    // Filtres avancés
    ['f-assoc', 'f-dept', 'f-activity', 'f-status', 'f-groupement', 'f-creation', 'f-ca', 'f-aum', 'f-structure', 'f-expertise']
        .forEach(id => $(id).addEventListener('change', () => {
            readFiltersFromUI(); FILTERS.folkOnly = false; SHOWN = PAGE_SIZE; clearActiveTiles(); renderAnnuaire();
        }));

    // Délégation : statut + Folk sur les fiches
    $('resultsList').addEventListener('change', e => {
        const sel = e.target.closest('.status-select');
        if (sel) {
            setStatus(sel.dataset.id, sel.value);
            sel.className = 'status-select status-' + (sel.value || '');
            return;
        }
        const chk = e.target.closest('.folk-toggle input');
        if (chk) {
            toggleFolk(chk.dataset.id, chk.checked);
            chk.closest('.folk-toggle').classList.toggle('on', chk.checked);
        }
    });

    // Acteurs / Groupements : recherche + filtres
    $('acteursSearch').addEventListener('input', debounce(renderActeurs, 200));
    $('f-acteur-cat').addEventListener('change', renderActeurs);
    $('f-acteur-pert').addEventListener('change', renderActeurs);
    $('groupementsSearch').addEventListener('input', debounce(renderGroupements, 200));
    $('f-group-type').addEventListener('change', renderGroupements);

    // Fermer une modale en cliquant l'arrière-plan
    document.querySelectorAll('.modal-overlay').forEach(ov => ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('open'); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open')); });
}
function toggleFilters() { $('filtersPanel').classList.toggle('open'); }
function toggleActeursFilters() { $('acteursFilters').classList.toggle('open'); }
function toggleGroupFilters() { $('groupFilters').classList.toggle('open'); }

/* ============================================================
   INIT
   ============================================================ */
async function init() {
    console.info('CGP Monitor v' + APP_VERSION);
    loadMaps();
    wireEvents();
    await loadData();
    populateAnnuaireFilters();
    updateStats();
    updateFolkIndicator();
    setSyncStatus(getSyncConfig().gistId ? 'syncing' : 'offline');
    renderDashboard();
    renderAnnuaire();
    await cloudLoad();

    // Confirmation visuelle après un clic MAJ
    try {
        if (sessionStorage.getItem('cgpMajClicked')) {
            sessionStorage.removeItem('cgpMajClicked');
            const now = new Date();
            $('lastUpdate').textContent = `Mis à jour : ${now.toLocaleDateString('fr-FR')} ${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
            const btn = $('majBtn');
            if (btn) {
                btn.textContent = '✓ MAJ'; btn.classList.add('done'); btn.disabled = false;
                setTimeout(() => { btn.textContent = '↻ MAJ'; btn.classList.remove('done'); }, 2000);
            }
        }
    } catch {}
}

/* Exposition des handlers inline */
Object.assign(window, {
    refreshData, openSyncSettings, saveSyncSettings, clearSyncSettings,
    openFolkSettings, saveFolkSettings, clearFolkSettings, pushFolk,
    exportCsv, toggleFilters, toggleActeursFilters, toggleGroupFilters,
    resetFilters, loadMore, closeModal,
});

document.addEventListener('DOMContentLoaded', init);
