// Homework Tablet — phone app (runs in Bluefy on iPhone, Chrome on Android/desktop).
import { db, newId } from './db.js';
import { TabletLink, MSG } from './ble.js';
import { fileToPages, pageBitmap, cropBox, canvasToBlob } from './images.js';
import { renderQuestion, renderHint, toJpeg } from './cards.js';
import { parseHomework, getHint, listModels, DEFAULT_MODEL } from './gemini.js';
import { decodeInk, inkToCanvas, hasInk } from './ink.js';
import { fetchCanvas } from './canvas_ics.js';
import { buildPdf } from './export_pdf.js';

const APP_VERSION = '1.0.0';
const RENDER_VERSION = 2;          // bump to force all question images to re-send
const $ = s => document.querySelector(s);

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  apiKey: '', model: DEFAULT_MODEL, pin: '', canvasFeed: '', canvasRelay: '',
  showOriginal: true, hintSeesWork: true, hintLanguage: 'English', canvasOnTablet: true, autoSync: true,
};
const settings = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('hw.settings') || '{}'));
const saveSettings = () => localStorage.setItem('hw.settings', JSON.stringify(settings));

// ------------------------------------------------------------------ state
let assignments = [];
let canvasEvents = [];
let canvasDismissed = new Set();
let route = { name: 'list' };
const link = new TabletLink();
let syncing = false, syncAgain = false;
const busy = new Set();            // assignment ids being read by AI

// ------------------------------------------------------------------ dom helpers
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function sheet(build) {
  const s = $('#sheet'), card = s.querySelector('.sheet-card');
  card.innerHTML = '';
  const close = () => { s.hidden = true; };
  card.append(...[].concat(build(close)));
  s.hidden = false;
  s.onclick = e => { if (e.target === s) close(); };
  return close;
}

function ask(title, { placeholder = '', value = '', type = 'text', okText = 'OK' } = {}) {
  return new Promise(resolve => {
    let input;
    sheet(close => [
      h('h2', {}, title),
      input = h('input', { type, placeholder, value, inputmode: type === 'tel' ? 'numeric' : undefined }),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => { close(); resolve(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { close(); resolve(input.value.trim()); } }, okText)),
    ]);
    setTimeout(() => input.focus(), 50);
  });
}

function confirmBox(title, text, okText = 'OK', danger = false) {
  return new Promise(resolve => {
    sheet(close => [
      h('h2', {}, title), h('p', { class: 'muted' }, text),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => { close(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { close(); resolve(true); } }, okText)),
    ]);
  });
}

// ------------------------------------------------------------------ dates
function dueInfo(due) {
  if (!due) return { text: 'No due date', cls: '', group: 'No due date', order: 9 };
  const d = new Date(due), now = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  const time = (d.getHours() || d.getMinutes()) ? ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  if (diff < 0 || (diff === 0 && d < now)) return { text: `Overdue · was due ${date}${time}`, cls: 'over', group: 'Overdue', order: 0 };
  if (diff === 0) return { text: `Due today${time}`, cls: 'soon', group: 'Today', order: 1 };
  if (diff === 1) return { text: `Due tomorrow${time}`, cls: 'soon', group: 'Tomorrow', order: 2 };
  if (diff < 7) return { text: `Due ${date}${time}`, cls: '', group: 'This week', order: 3 };
  return { text: `Due ${date}${time}`, cls: '', group: 'Later', order: 4 };
}
const toLocalInput = ms => { if (!ms) return ''; const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

const SUBJ_COLORS = ['#2563EB', '#DC2626', '#16A34A', '#9333EA', '#EA580C', '#0891B2', '#DB2777', '#65A30D'];
function fnv(s) { let x = 2166136261; for (const c of String(s)) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619) >>> 0; } return x >>> 0; }
function subjColor(s) { let x = 2166136261; for (const c of String(s || '').toLowerCase()) { x ^= c.charCodeAt(0) & 255; x = Math.imul(x, 16777619) >>> 0; } return SUBJ_COLORS[x % 8]; }

function styleFor(a, q) {
  if (a.style && a.style !== 'auto') return a.style;
  if (q && q.paper) return q.paper;
  return /math|alg|geom|calc|phys|chem|stat|trig/i.test(a.subject || '') ? 'grid' : 'lines';
}
const STYLE_CODE = { blank: 0, lines: 1, grid: 2 };

// Version of a question's image: changes whenever anything shown on it changes.
function cardVersion(a, q) {
  return fnv(JSON.stringify([RENDER_VERSION, q.label, q.text, q.box, q.figures, q.page, a.title, settings.showOriginal])) & 0x7fffffff || 1;
}

// ------------------------------------------------------------------ data
async function load() {
  assignments = (await db.allAssignments()) || [];
  canvasEvents = (await db.get('canvasEvents', [])) || [];
  canvasDismissed = new Set((await db.get('canvasDismissed', [])) || []);
}
async function save(a) {
  a.updated = Date.now();
  await db.putAssignment(a);
  const i = assignments.findIndex(x => x.id === a.id);
  if (i >= 0) assignments[i] = a; else assignments.push(a);
  scheduleSync();
}
const findA = id => assignments.find(a => a.id === id);

async function getPageBitmap(a, n) {
  const pid = a.pages && a.pages[n - 1];
  if (!pid) return null;
  const blob = await db.getBlob(`page:${a.id}:${pid}`);
  return blob ? pageBitmap(`${a.id}:${pid}`, blob) : null;
}
async function getInk(a, q) { return decodeInk(await db.getBlob(`ink:${a.id}:${q.id}`)); }
function answeredCount(a) { return (a.questions || []).filter(q => q.answered).length; }

// ------------------------------------------------------------------ tablet connection
function updateChip() {
  const chip = $('#tabletChip');
  chip.classList.remove('on', 'wait');
  if (!link.supported) { chip.textContent = 'No Bluetooth here'; return; }
  if (link.connected) {
    const bat = link.info && link.info.bat >= 0 ? ` · ${link.info.bat}%` : '';
    chip.textContent = link.info && link.info.paired === false ? 'Tablet · not paired' : `Tablet ✓${bat}`;
    chip.classList.add(link.info && link.info.paired === false ? 'wait' : 'on');
  } else if (link.device) { chip.textContent = 'Reconnect tablet'; }
  else chip.textContent = 'Connect tablet';
}

async function connectTablet() {
  if (!link.supported) {
    sheet(close => [h('h2', {}, 'Bluetooth not available'),
      h('p', {}, 'Safari and Chrome on iPhone can\'t use Bluetooth from a web page. Open this page in the free ',
        h('b', {}, 'Bluefy'), ' browser app instead (search "Bluefy" in the App Store).'),
      h('button', { class: 'btn primary block', onclick: close }, 'OK')]);
    return;
  }
  try {
    if (link.device && !link.connected) await link.connect();
    else await link.choose();
    await afterConnect();
  } catch (e) {
    if (e && e.name === 'NotFoundError') return;   // user cancelled the chooser
    toast('Could not connect: ' + (e.message || e));
  }
  updateChip();
}

async function ensurePaired() {
  let info = await link.hello(settings.pin);
  updateChip();
  for (let tries = 0; !info.paired && tries < 3; tries++) {
    const code = await ask('Enter the pairing code shown on the tablet', { type: 'tel', placeholder: '4 digits', okText: 'Pair' });
    if (!code) throw new Error('Pairing cancelled');
    settings.pin = code; saveSettings();
    info = await link.hello(settings.pin);
    updateChip();
  }
  if (!info.paired) throw new Error('Wrong pairing code');
  return info;
}

async function afterConnect() {
  try { await ensurePaired(); toast('Tablet connected'); if (settings.autoSync) await sync(); }
  catch (e) { toast(e.message || String(e)); }
}

link.addEventListener('state', () => updateChip());
link.addEventListener('reconnected', () => afterConnect());
link.addEventListener('message', ev => {
  const m = ev.detail;
  if (m.type === MSG.T_HINT_REQ) handleHintRequest(m.json);
  else if (m.type === MSG.T_ERROR && m.json.msg === 'not paired') toast('The tablet wants the pairing code again.');
});

// ------------------------------------------------------------------ sync
let syncTimer;
function scheduleSync() {
  if (!settings.autoSync || !link.connected) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync().catch(() => {}), 2500);
}

function syncProgress(text, frac) {
  const bar = $('#syncbar');
  if (text === null) { bar.hidden = true; return; }
  bar.hidden = false;
  $('#syncbarText').textContent = text;
  $('#syncbarFill').style.width = `${Math.round((frac || 0) * 100)}%`;
}

function canvasOnlyItems() {
  if (!settings.canvasOnTablet) return [];
  const linked = new Set(assignments.map(a => a.canvasUid).filter(Boolean));
  const now = Date.now(), until = now + 14 * 86400000;
  return canvasEvents.filter(e => e.isAssignment && e.due >= now - 86400000 && e.due <= until && !linked.has(e.uid) && !canvasDismissed.has(e.uid));
}

function buildManifest() {
  const list = assignments.filter(a => !a.done).map(a => ({
    id: a.id, subj: a.subject || '', title: a.title || 'Untitled', due: a.due ? Math.floor(a.due / 1000) : 0,
    style: STYLE_CODE[styleFor(a, null)] ?? 1,
    q: (a.questions || []).map(q => ({ id: q.id, n: q.label, v: cardVersion(a, q), s: STYLE_CODE[styleFor(a, q)] ?? 1 })),
  }));
  for (const e of canvasOnlyItems()) {
    list.push({ id: 'c' + fnv(e.uid).toString(36), subj: e.course, title: e.title, due: Math.floor(e.due / 1000), style: 1, c: 1, q: [] });
  }
  return { a: list };
}

async function pullInk(a, q, expectVersion) {
  const m = await link.request(MSG.GET_INK, { a: a.id, q: q.id },
    x => x.type === MSG.T_INK && x.json.a === a.id && x.json.q === q.id, { timeout: 20000 });
  if (m.blob.length) {
    await db.putBlob(`ink:${a.id}:${q.id}`, m.blob.buffer.slice(m.blob.byteOffset, m.blob.byteOffset + m.blob.byteLength));
    q.answered = hasInk(decodeInk(m.blob));
  }
  q.inkVer = m.json.v || expectVersion || 0;
  return m;
}

async function sync() {
  if (!link.connected) { toast('Connect the tablet first'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; $('#syncBtn').classList.add('spin');
  try {
    await ensurePaired();
    // 1. Collect new handwriting first (so nothing is lost if an assignment was removed).
    syncProgress('Checking the tablet…', 0.05);
    let st = await link.request(MSG.GET_STATUS, {}, x => x.type === MSG.T_STATUS);
    const changed = new Set();
    const pulls = (st.json.items || []).filter(it => { const a = findA(it.a); const q = a && (a.questions || []).find(z => z.id === it.q); return q && it.ink > (q.inkVer || 0); });
    for (let i = 0; i < pulls.length; i++) {
      const it = pulls[i]; const a = findA(it.a); const q = a.questions.find(z => z.id === it.q);
      syncProgress(`Getting your answers (${i + 1}/${pulls.length})…`, 0.1 + 0.3 * i / pulls.length);
      await pullInk(a, q, it.ink);
      changed.add(a);
    }
    for (const a of changed) await db.putAssignment(a);

    // 2. Send the list of assignments.
    syncProgress('Sending the homework list…', 0.45);
    await link.send(MSG.MANIFEST, buildManifest());

    // 3. Send question images the tablet doesn't have yet.
    st = await link.request(MSG.GET_STATUS, {}, x => x.type === MSG.T_STATUS);
    const sends = [];
    for (const it of st.json.items || []) {
      const a = findA(it.a); const q = a && (a.questions || []).find(z => z.id === it.q);
      if (q && it.card !== cardVersion(a, q)) sends.push([a, q]);
    }
    for (let i = 0; i < sends.length; i++) {
      const [a, q] = sends[i];
      syncProgress(`Sending questions (${i + 1}/${sends.length})…`, 0.5 + 0.45 * i / sends.length);
      const jpg = await cardJpeg(a, q);
      await link.send(MSG.CARD, { a: a.id, q: q.id, v: cardVersion(a, q) }, new Uint8Array(await jpg.arrayBuffer()));
    }
    // 4. Any answers written while we were syncing (or that the tablet had before it knew the list).
    for (const it of st.json.items || []) {
      const a = findA(it.a); const q = a && (a.questions || []).find(z => z.id === it.q);
      if (q && it.ink > (q.inkVer || 0)) {
        syncProgress('Getting your answers…', 0.97);
        await pullInk(a, q, it.ink); pulls.push(it); changed.add(a);
        await db.putAssignment(a);
      }
    }
    syncProgress(null);
    if (pulls.length || sends.length) toast(`Synced${pulls.length ? ` · ${pulls.length} answer${pulls.length > 1 ? 's' : ''} saved` : ''}${sends.length ? ` · ${sends.length} question${sends.length > 1 ? 's' : ''} sent` : ''}`);
    await db.set('lastSync', Date.now());
    if (changed.size) render();
  } catch (e) {
    syncProgress(null);
    toast('Sync stopped: ' + (e.message || e), 4000);
  } finally {
    syncing = false; $('#syncBtn').classList.remove('spin');
    if (syncAgain) { syncAgain = false; setTimeout(() => sync().catch(() => {}), 300); }
  }
}

async function cardJpeg(a, q) {
  const c = await renderQuestion(q, {
    width: 480, scale: 1, fontSize: 19, showOriginal: settings.showOriginal, subtitle: a.title,
    getPage: n => getPageBitmap(a, n), maxFigH: 300, maxOrigH: 420,
  });
  return toJpeg(c, 0.8);
}

// ------------------------------------------------------------------ hints
async function handleHintRequest({ a: aid, q: qid, level }) {
  const fail = msg => link.send(MSG.HINT_ERR, { a: aid, q: qid, msg }).catch(() => {});
  const a = findA(aid), q = a && (a.questions || []).find(z => z.id === qid);
  if (!a || !q) return fail('That question is not on the phone anymore. Sync again.');
  if (!settings.apiKey) return fail('Add your free Gemini API key in the phone app (Settings).');
  level = Math.min(3, Math.max(1, level || 1));
  toast(`Getting hint ${level} for question ${q.label}…`);
  try {
    let workImage = null;
    if (settings.hintSeesWork) {
      try { await pullInk(a, q); await db.putAssignment(a); } catch (e) { /* use what we have */ }
      const ink = await getInk(a, q);
      if (hasInk(ink)) workImage = await canvasToBlob(inkToCanvas(ink, styleFor(a, q), { widthPx: 900 }), 'image/png');
    }
    let questionImage = null;
    if (q.box) {
      const crop = cropBox(await getPageBitmap(a, q.page), q.box, 0.02);
      if (crop) questionImage = await canvasToBlob(crop, 'image/jpeg', 0.85);
    }
    const text = await getHint({
      key: settings.apiKey, model: settings.model || DEFAULT_MODEL, subject: a.subject, title: a.title,
      question: q.text, level, previous: (q.hints || []).map(x => x.text), questionImage, workImage,
      language: settings.hintLanguage,
    });
    q.hints = (q.hints || []).concat([{ level, text, at: Date.now() }]);
    await db.putAssignment(a);
    const img = await toJpeg(await renderHint(text, level, { width: 480, fontSize: 19 }), 0.82);
    await link.send(MSG.HINT, { a: a.id, q: q.id, level }, new Uint8Array(await img.arrayBuffer()));
    toast(`Hint sent to the tablet (question ${q.label})`);
    if (route.name === 'detail' && route.id === a.id) render();
  } catch (e) {
    fail(e.message || String(e));
    toast('Hint failed: ' + (e.message || e), 4000);
  }
}

// ------------------------------------------------------------------ adding homework
async function pickFiles(camera) {
  const input = camera ? $('#pickCamera') : $('#pickFiles');
  input.value = '';
  return new Promise(resolve => {
    input.onchange = () => resolve(Array.from(input.files || []));
    input.click();
  });
}

async function addPages(a, files) {
  if (!files.length) return;
  a.pages = a.pages || [];
  for (const f of files) {
    toast(`Adding ${f.name || 'photo'}…`, 6000);
    const pages = await fileToPages(f, msg => toast(msg, 6000));
    for (const blob of pages) {
      const pid = newId('p');
      await db.putBlob(`page:${a.id}:${pid}`, blob);
      a.pages.push(pid);
    }
  }
  await save(a);
  toast(`${a.pages.length} page${a.pages.length > 1 ? 's' : ''} ready`);
}

async function newHomework(camera, fromCanvas) {
  const files = await pickFiles(camera);
  if (!files.length && !fromCanvas) return;
  const a = {
    id: newId('a'), title: fromCanvas ? fromCanvas.title : '', subject: fromCanvas ? fromCanvas.course : '',
    due: fromCanvas ? fromCanvas.due : null, style: 'auto', created: Date.now(), done: false,
    canvasUid: fromCanvas ? fromCanvas.uid : null, canvasUrl: fromCanvas ? fromCanvas.url : null,
    pages: [], questions: [],
  };
  await save(a);
  go({ name: 'detail', id: a.id });
  if (files.length) {
    await addPages(a, files);
    render();
    if (settings.apiKey) readWithAI(a);
  }
}

async function readWithAI(a) {
  if (!settings.apiKey) { toast('Add your free Gemini API key in Settings first'); go({ name: 'settings' }); return; }
  if (!a.pages || !a.pages.length) { toast('Add photos or a PDF of the assignment first'); return; }
  if (a.questions && a.questions.some(q => q.answered)) {
    const ok = await confirmBox('Read again?', 'This replaces the question list. Answers you already wrote stay on questions whose number didn\'t change.', 'Read again');
    if (!ok) return;
  }
  busy.add(a.id); render();
  try {
    const pages = [];
    for (const pid of a.pages) pages.push(await db.getBlob(`page:${a.id}:${pid}`));
    const r = await parseHomework({ key: settings.apiKey, model: settings.model || DEFAULT_MODEL, pages, hint: a.title ? `Assignment title: ${a.title}` : '' });
    if (!r.questions.length) throw new Error('No questions were found. Try clearer photos.');
    const old = new Map((a.questions || []).map(q => [q.label, q]));
    a.questions = r.questions.map(q => {
      const prev = old.get(q.label);
      return Object.assign({ id: prev ? prev.id : newId('q'), inkVer: prev ? prev.inkVer : 0, answered: prev ? prev.answered : false, hints: prev ? prev.hints : [] }, q);
    });
    if (!a.title) a.title = r.title || 'Homework';
    if (!a.subject) a.subject = r.subject || '';
    if (!a.due && r.due_date && /^\d{4}-\d{2}-\d{2}$/.test(r.due_date)) {
      const [Y, M, D] = r.due_date.split('-').map(Number);
      a.due = new Date(Y, M - 1, D, 23, 59).getTime();
    }
    await save(a);
    toast(`Found ${a.questions.length} question${a.questions.length > 1 ? 's' : ''}`);
  } catch (e) {
    toast(e.message || String(e), 5000);
  } finally {
    busy.delete(a.id); render();
  }
}

// ------------------------------------------------------------------ PDF
async function exportPdf(a) {
  toast('Making the PDF…', 20000);
  try {
    if (link.connected) {
      try {
        const st = await link.request(MSG.GET_STATUS, {}, x => x.type === MSG.T_STATUS);
        for (const it of st.json.items || []) {
          if (it.a !== a.id) continue;
          const q = a.questions.find(z => z.id === it.q);
          if (q && it.ink > (q.inkVer || 0)) await pullInk(a, q, it.ink);
        }
        await db.putAssignment(a);
      } catch (e) { /* export what we have */ }
    }
    const inks = new Map();
    for (const q of a.questions || []) inks.set(q.id, await getInk(a, q));
    const bytes = await buildPdf(a, { inks, getPage: n => getPageBitmap(a, n), styleFor: q => styleFor(a, q), includeOriginal: false });
    const name = `${[a.subject, a.title].filter(Boolean).join(' - ') || 'Homework'}.pdf`.replace(/[\\/:*?"<>|]+/g, '_');
    const file = new File([bytes], name, { type: 'application/pdf' });
    $('#toast').hidden = true;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    sheet(close => [h('h2', {}, 'PDF ready'),
      h('p', { class: 'muted' }, 'Open it, then use the share button to save it to Files, print it, or upload it to Canvas.'),
      h('a', { class: 'btn primary block', href: url, download: name, target: '_blank', onclick: () => setTimeout(close, 500) }, 'Open PDF'),
      h('button', { class: 'btn block', style: 'margin-top:8px', onclick: close }, 'Close')]);
  } catch (e) {
    toast('PDF failed: ' + (e.message || e), 5000);
  }
}

// ------------------------------------------------------------------ views
function go(r) { route = r; window.scrollTo(0, 0); render(); }

function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active',
    b.dataset.tab === (route.name === 'detail' ? 'list' : route.name)));
  const v = $('#view');
  v.innerHTML = '';
  document.querySelectorAll('.fab').forEach(f => f.remove());
  if (route.name === 'list') v.append(viewList());
  else if (route.name === 'detail') v.append(viewDetail());
  else if (route.name === 'canvas') v.append(viewCanvas());
  else if (route.name === 'settings') v.append(viewSettings());
  updateChip();
}

function viewList() {
  const frag = document.createDocumentFragment();
  if (!link.supported) frag.append(h('div', { class: 'banner' }, 'To talk to the tablet, open this page in the ', h('b', {}, 'Bluefy'), ' browser app (free in the App Store).'));
  if (!settings.apiKey) frag.append(h('div', { class: 'banner info' }, 'First step: add your free Gemini API key in ', h('a', { href: '#', onclick: e => { e.preventDefault(); go({ name: 'settings' }); } }, 'Settings'), '.'));

  const active = assignments.filter(a => !a.done);
  const done = assignments.filter(a => a.done);
  if (!active.length) {
    frag.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '📝'),
      h('p', {}, 'No homework yet.'), h('p', { class: 'small' }, 'Tap "+ New" to photograph an assignment or pick a PDF. You can also add due dates from the Canvas tab.')));
  }
  const groups = new Map();
  active.sort((x, y) => (x.due || 9e15) - (y.due || 9e15)).forEach(a => {
    const g = dueInfo(a.due).group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(a);
  });
  for (const [g, list] of [...groups.entries()].sort((x, y) => dueInfo(x[1][0].due).order - dueInfo(y[1][0].due).order)) {
    frag.append(h('h3', {}, g));
    for (const a of list) frag.append(assignmentCard(a));
  }
  if (done.length) {
    const det = h('details', {}, h('summary', {}, `Finished (${done.length})`));
    for (const a of done) det.append(assignmentCard(a));
    frag.append(h('h3', {}, ''), det);
  }
  document.body.append(h('button', { class: 'fab', onclick: () => chooseSource() }, '+ New'));
  return frag;
}

function chooseSource(fromCanvas) {
  sheet(close => [
    h('h2', {}, fromCanvas ? `Add pages for "${fromCanvas.title}"` : 'New homework'),
    h('button', { class: 'btn primary block', onclick: () => { close(); newHomework(true, fromCanvas); } }, '📷  Take a photo'),
    h('div', { style: 'height:8px' }),
    h('button', { class: 'btn block', onclick: () => { close(); newHomework(false, fromCanvas); } }, '🖼️  Choose photos or a PDF'),
    fromCanvas ? [h('div', { style: 'height:8px' }), h('button', { class: 'btn block', onclick: async () => { close(); await newHomeworkNoPages(fromCanvas); } }, 'Just track the due date for now')] : [],
    h('p', { class: 'muted small' }, 'Tip: take one photo per page, flat and well lit. You can add more pages later.'),
  ]);
}

async function newHomeworkNoPages(ev) {
  const a = { id: newId('a'), title: ev.title, subject: ev.course, due: ev.due, style: 'auto', created: Date.now(), done: false,
    canvasUid: ev.uid, canvasUrl: ev.url, pages: [], questions: [] };
  await save(a);
  go({ name: 'detail', id: a.id });
}

function assignmentCard(a) {
  const di = dueInfo(a.due), n = (a.questions || []).length, done = answeredCount(a);
  let badge = null;
  if (busy.has(a.id)) badge = h('span', { class: 'badge warn' }, h('span', { class: 'spinner' }), ' Reading');
  else if (!a.pages || !a.pages.length) badge = h('span', { class: 'badge warn' }, 'Add pages');
  else if (!n) badge = h('span', { class: 'badge warn' }, 'Not read yet');
  else if (done === n) badge = h('span', { class: 'badge ok' }, 'All answered');
  return h('div', { class: 'card', onclick: () => go({ name: 'detail', id: a.id }) },
    h('div', { class: 'row' },
      h('span', { class: 'dot', style: `background:${subjColor(a.subject)}` }),
      h('span', { class: 'muted small grow' }, a.subject || 'No subject'), badge),
    h('div', { class: 'title' }, a.title || 'Untitled'),
    h('div', { class: `due ${di.cls}` }, di.text),
    n ? h('div', {}, h('div', { class: 'muted small', style: 'margin-top:4px' }, `${done} of ${n} answered`),
      h('div', { class: 'progress' }, h('div', { style: `width:${Math.round(100 * done / n)}%` }))) : null);
}

function viewDetail() {
  const a = findA(route.id);
  if (!a) { setTimeout(() => go({ name: 'list' }), 0); return document.createDocumentFragment(); }
  const frag = document.createDocumentFragment();
  const field = (label, input) => h('div', { class: 'field' }, h('label', {}, label), input);
  const saveField = (k, fn) => async e => { a[k] = fn ? fn(e.target.value) : e.target.value; await save(a); };
  const subjects = [...new Set(assignments.map(x => x.subject).filter(Boolean).concat(['Russian', 'Math', 'Physics', 'Chemistry', 'English', 'History']))];

  frag.append(h('button', { class: 'btn', style: 'margin-bottom:10px', onclick: () => go({ name: 'list' }) }, '‹ All homework'));
  frag.append(h('div', { class: 'card' },
    field('Title', h('input', { value: a.title || '', placeholder: 'e.g. Упражнение 5', onchange: saveField('title') })),
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, field('Subject', h('input', { value: a.subject || '', list: 'subjList', placeholder: 'Subject', onchange: saveField('subject') }))),
      h('div', { class: 'grow' }, field('Paper on tablet', h('select', { onchange: saveField('style') },
        ...[['auto', 'Automatic'], ['lines', 'Lined'], ['grid', 'Graph paper'], ['blank', 'Blank']].map(([v, t]) => h('option', { value: v, selected: (a.style || 'auto') === v }, t)))))),
    field('Due', h('input', { type: 'datetime-local', value: toLocalInput(a.due), onchange: saveField('due', v => (v ? new Date(v).getTime() : null)) })),
    h('datalist', { id: 'subjList' }, ...subjects.map(s => h('option', { value: s }))),
    a.canvasUrl ? h('a', { href: a.canvasUrl, target: '_blank', class: 'small' }, 'Open in Canvas ↗') : null));

  // pages
  const pagesBox = h('div', { class: 'pages' });
  (a.pages || []).forEach(async (pid, i) => {
    const blob = await db.getBlob(`page:${a.id}:${pid}`);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    pagesBox.append(h('div', { class: 'pg' }, h('img', { src: url, alt: `Page ${i + 1}` }),
      h('button', { class: 'x', onclick: async ev => { ev.stopPropagation();
        if (!(await confirmBox('Remove page?', `Remove page ${i + 1}? Read with AI again afterwards.`, 'Remove', true))) return;
        a.pages = a.pages.filter(x => x !== pid); await db.deleteBlob(`page:${a.id}:${pid}`); await save(a); render(); } }, '×')));
  });
  const reading = busy.has(a.id);
  frag.append(h('div', { class: 'card' },
    h('div', { class: 'row' }, h('b', { class: 'grow' }, `Pages (${(a.pages || []).length})`)),
    pagesBox,
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: async () => { await addPages(a, await pickFiles(true)); render(); } }, '📷 Photo'),
      h('button', { class: 'btn', onclick: async () => { await addPages(a, await pickFiles(false)); render(); } }, '🖼️ Photos / PDF')),
    h('button', { class: 'btn primary block', style: 'margin-top:10px', disabled: reading || !(a.pages || []).length, onclick: () => readWithAI(a) },
      reading ? [h('span', { class: 'spinner' }), ' Reading the pages…'] : ((a.questions || []).length ? '✨ Read with AI again' : '✨ Read with AI'))));

  // questions
  const qs = a.questions || [];
  if (qs.length) frag.append(h('h3', {}, `Questions (${answeredCount(a)}/${qs.length} answered)`));
  qs.forEach((q, idx) => frag.append(questionCard(a, q, idx)));
  if (a.pages && a.pages.length) frag.append(h('button', { class: 'btn block', style: 'margin:6px 0 10px', onclick: async () => {
    a.questions = qs.concat([{ id: newId('q'), label: String(qs.length + 1), text: '', page: 1, box: null, figures: [], paper: null, hints: [], inkVer: 0 }]);
    await save(a); render(); } }, '+ Add a question by hand'));

  frag.append(h('div', { class: 'card' },
    h('div', { class: 'btns' },
      h('button', { class: 'btn primary', disabled: !qs.length, onclick: () => exportPdf(a) }, '📄 Export PDF'),
      h('button', { class: 'btn', onclick: () => (link.connected ? sync() : connectTablet()) }, '🔄 Send to tablet')),
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: async () => {
        if (!a.done && link.connected) await sync();   // save the latest answers first
        else if (!a.done && qs.some(q => (q.inkVer || 0) === 0)) {
          if (!(await confirmBox('Tablet not connected', 'Answers on the tablet that haven\'t been synced yet will be lost when it removes this homework. Mark finished anyway?', 'Mark finished'))) return;
        }
        a.done = !a.done; await save(a); toast(a.done ? 'Marked finished (removed from the tablet at next sync)' : 'Back on the list'); render(); } },
        a.done ? '↩︎ Not finished' : '✅ Mark finished'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmBox('Delete homework?', 'This deletes the pages, questions and your answers on this phone (and removes it from the tablet).', 'Delete', true))) return;
        await db.deleteAssignment(a.id); await db.deleteBlobsWithPrefix(`page:${a.id}:`); await db.deleteBlobsWithPrefix(`ink:${a.id}:`);
        assignments = assignments.filter(x => x.id !== a.id);
        if (link.connected) link.send(MSG.DELETE, { a: a.id }).catch(() => {});
        scheduleSync(); go({ name: 'list' }); } }, '🗑 Delete'))));
  return frag;
}

function questionCard(a, q, idx) {
  const box = h('div', { class: 'card q' });
  const head = h('div', { class: 'qhead' },
    h('b', { class: 'grow' }, `Question ${q.label}`),
    q.answered ? h('span', { class: 'badge ok' }, 'Answered') : null,
    (q.hints || []).length ? h('span', { class: 'badge warn' }, `${q.hints.length} hint${q.hints.length > 1 ? 's' : ''}`) : null,
    h('button', { class: 'btn', style: 'padding:6px 12px', onclick: () => edit() }, 'Edit'));
  const imgHolder = h('div', {}, h('div', { class: 'muted small', style: 'padding:10px 14px' }, h('span', { class: 'spinner' }), ' drawing…'));
  box.append(head, imgHolder);
  renderQuestion(q, { width: 480, scale: 2, fontSize: 19, showOriginal: settings.showOriginal, getPage: n => getPageBitmap(a, n), maxFigH: 300, maxOrigH: 420 })
    .then(c => { c.className = 'cardimg'; imgHolder.replaceChildren(c); })
    .catch(e => { imgHolder.replaceChildren(h('div', { class: 'muted small', style: 'padding:10px 14px' }, 'Could not draw: ' + e.message)); });

  if (q.answered || q.inkVer) {
    const ans = h('div', { class: 'answer' }, h('div', { class: 'muted small' }, 'Your answer (from the tablet)'));
    box.append(ans);
    getInk(a, q).then(ink => { if (hasInk(ink)) ans.append(inkToCanvas(ink, styleFor(a, q), { widthPx: 900, minHeightUnits: 120 })); else ans.append(h('div', { class: 'muted small' }, '(empty)')); });
  }
  if ((q.hints || []).length) {
    box.append(h('details', { class: 'hints' }, h('summary', {}, 'Hints you got'),
      ...q.hints.map(x => h('p', {}, h('b', {}, `Hint ${x.level}: `), x.text))));
  }

  function edit() {
    const label = h('input', { value: q.label });
    const text = h('textarea', { rows: 8 }, q.text || '');
    const paper = h('select', {}, ...[['', 'Same as homework'], ['lines', 'Lined'], ['grid', 'Graph paper'], ['blank', 'Blank']]
      .map(([v, t]) => h('option', { value: v, selected: (q.paper || '') === v }, t)));
    const editor = h('div', { class: 'editor' },
      h('div', { class: 'field' }, h('label', {}, 'Number / label'), label),
      h('div', { class: 'field' }, h('label', {}, 'Question text (math: $x^2$, $$\\frac{a}{b}$$)'), text),
      h('div', { class: 'field' }, h('label', {}, 'Paper'), paper),
      h('div', { class: 'btns' },
        h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmBox('Delete question?', 'Its answer on the tablet will be removed at the next sync.', 'Delete', true))) return;
          a.questions = a.questions.filter(z => z !== q); await db.deleteBlob(`ink:${a.id}:${q.id}`); await save(a); render(); } }, 'Delete'),
        h('button', { class: 'btn', onclick: () => render() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          q.label = label.value.trim() || String(idx + 1); q.text = text.value; q.paper = paper.value || null;
          await save(a); render(); } }, 'Save')));
    box.replaceChildren(head, editor);
  }
  return box;
}

function viewCanvas() {
  const frag = document.createDocumentFragment();
  frag.append(h('h2', {}, 'Canvas due dates'));
  if (!settings.canvasFeed) {
    frag.append(h('div', { class: 'card' },
      h('p', {}, 'Connect your Canvas calendar to see due dates here and on the tablet.'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Open Canvas in a browser and go to ', h('b', {}, 'Calendar'), '.'),
        h('li', {}, 'At the bottom right, tap ', h('b', {}, 'Calendar Feed'), ' and copy the link.'),
        h('li', {}, 'Paste it in ', h('a', { href: '#', onclick: e => { e.preventDefault(); go({ name: 'settings' }); } }, 'Settings → Canvas'), '.'))));
    return frag;
  }
  const status = h('div', { class: 'muted small' });
  frag.append(h('div', { class: 'row', style: 'margin-bottom:10px' }, h('div', { class: 'grow' }, status),
    h('button', { class: 'btn', onclick: () => refreshCanvas(true) }, '↻ Refresh')));
  db.get('canvasFetched').then(t => { status.textContent = t ? `Updated ${new Date(t).toLocaleString()}` : 'Not loaded yet'; });

  const linked = new Map(assignments.filter(a => a.canvasUid).map(a => [a.canvasUid, a]));
  const now = Date.now();
  const upcoming = canvasEvents.filter(e => e.due >= now - 2 * 86400000 && e.due <= now + 45 * 86400000 && !canvasDismissed.has(e.uid))
    .sort((x, y) => x.due - y.due);
  if (!upcoming.length) frag.append(h('div', { class: 'empty' }, h('p', {}, 'Nothing due in the next 45 days. 🎉')));
  let lastGroup = '';
  for (const e of upcoming) {
    const di = dueInfo(e.due);
    if (di.group !== lastGroup) { frag.append(h('h3', {}, di.group)); lastGroup = di.group; }
    const a = linked.get(e.uid);
    frag.append(h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'dot', style: `background:${subjColor(e.course)}` }), h('span', { class: 'muted small grow' }, e.course || 'Canvas'),
        a ? null : h('button', { class: 'muted', style: 'font-size:18px', 'aria-label': 'Hide', onclick: async () => { canvasDismissed.add(e.uid); await db.set('canvasDismissed', [...canvasDismissed]); scheduleSync(); render(); } }, '×')),
      h('div', { class: 'title' }, e.title),
      h('div', { class: `due ${di.cls}` }, di.text),
      h('div', { class: 'btns' },
        a ? h('button', { class: 'btn', onclick: () => go({ name: 'detail', id: a.id }) }, 'Open') :
          h('button', { class: 'btn primary', onclick: () => chooseSource(e) }, '+ Add homework'),
        e.url ? h('a', { class: 'btn', href: e.url, target: '_blank' }, 'Canvas ↗') : null)));
  }
  return frag;
}

async function refreshCanvas(showToast) {
  if (!settings.canvasFeed) return;
  try {
    canvasEvents = await fetchCanvas(settings.canvasFeed, settings.canvasRelay);
    await db.set('canvasEvents', canvasEvents);
    await db.set('canvasFetched', Date.now());
    // keep linked homework due dates in step with Canvas
    for (const a of assignments) {
      const e = a.canvasUid && canvasEvents.find(x => x.uid === a.canvasUid);
      if (e && e.due !== a.due) { a.due = e.due; await db.putAssignment(a); }
    }
    if (showToast) toast(`Canvas: ${canvasEvents.filter(e => e.isAssignment).length} assignments loaded`);
    scheduleSync();
    if (route.name === 'canvas' || route.name === 'list') render();
  } catch (e) {
    if (showToast) toast(e.message || String(e), 5000);
  }
}

function viewSettings() {
  const frag = document.createDocumentFragment();
  const field = (label, input, help) => h('div', { class: 'field' }, h('label', {}, label), input, help ? h('div', { class: 'muted small', style: 'margin-top:4px' }, help) : null);
  const bind = (k, el, conv = v => v) => { el.addEventListener('change', () => { settings[k] = conv(el.type === 'checkbox' ? el.checked : el.value.trim()); saveSettings(); scheduleSync(); }); return el; };
  const toggle = (k, label) => h('label', { class: 'toggle' }, h('span', {}, label), bind(k, h('input', { type: 'checkbox', checked: !!settings[k] })));

  frag.append(h('h2', {}, 'Settings'));

  // Gemini
  const modelSel = h('select', {}, h('option', { value: settings.model }, settings.model));
  bind('model', modelSel);
  const keyInput = bind('apiKey', h('input', { type: 'password', value: settings.apiKey, placeholder: 'AIza…', autocomplete: 'off' }));
  const keyStatus = h('div', { class: 'muted small' });
  frag.append(h('h3', {}, 'AI (Google Gemini, free)'), h('div', { class: 'card' },
    field('Gemini API key', keyInput, h('span', {}, 'Free key: ', h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank' }, 'aistudio.google.com/apikey'),
      ' → "Create API key". Stored only on this phone. Free-tier requests may be used by Google to improve its products, so don\'t upload anything private.')),
    field('Model', modelSel, 'gemini-flash-latest always points at Google\'s current fast model. If you hit the free limit, try a "flash-lite" model.'),
    h('button', { class: 'btn', onclick: async () => {
      keyStatus.textContent = 'Checking…';
      try {
        const models = await listModels(settings.apiKey);
        modelSel.replaceChildren(...[...new Set([settings.model, DEFAULT_MODEL, ...models])].map(m => h('option', { value: m, selected: m === settings.model }, m)));
        keyStatus.textContent = `✓ Key works. ${models.length} models available.`;
      } catch (e) { keyStatus.textContent = '✗ ' + e.message; }
    } }, 'Check key & list models'), keyStatus,
    toggle('hintSeesWork', 'Hints can look at my handwriting'),
    field('Hint language', bind('hintLanguage', h('select', {}, ...['English', 'Russian', 'Spanish', 'French', 'German', 'Chinese']
      .map(l => h('option', { value: l, selected: settings.hintLanguage === l }, l)))))));

  // Tablet
  frag.append(h('h3', {}, 'Tablet'), h('div', { class: 'card' },
    field('Pairing code', bind('pin', h('input', { type: 'tel', inputmode: 'numeric', value: settings.pin, placeholder: 'shown on the tablet (Settings ⚙︎)' }))),
    toggle('autoSync', 'Sync automatically'),
    toggle('showOriginal', 'Show the original scan under each question'),
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: () => connectTablet() }, link.connected ? 'Reconnect' : 'Connect tablet'),
      link.connected ? h('button', { class: 'btn', onclick: () => { link.disconnect(); updateChip(); render(); } }, 'Disconnect') : null),
    link.info ? h('p', { class: 'muted small' }, `Tablet firmware ${link.info.fw} · storage: ${link.info.store}`) : null));

  // Canvas
  frag.append(h('h3', {}, 'Canvas'), h('div', { class: 'card' },
    field('Calendar feed link', bind('canvasFeed', h('input', { type: 'url', value: settings.canvasFeed, placeholder: 'https://…/feeds/calendars/user_….ics' })),
      'Canvas → Calendar → "Calendar Feed" (bottom right) → copy the link.'),
    field('Relay URL (only if needed)', bind('canvasRelay', h('input', { type: 'url', value: settings.canvasRelay, placeholder: 'https://script.google.com/macros/s/…/exec' }))),
    h('details', {}, h('summary', {}, 'What is the relay?'),
      h('p', { class: 'small' }, 'Canvas often blocks web pages from reading the calendar feed. The relay is a 10-line Google Apps Script you run on your own Google account for free. The code and steps are in proxy/canvas-relay.gs in this project.')),
    toggle('canvasOnTablet', 'Show Canvas due dates on the tablet'),
    h('button', { class: 'btn', onclick: () => refreshCanvas(true) }, 'Load Canvas now')));

  frag.append(h('h3', {}, 'About'), h('div', { class: 'card small muted' },
    h('p', {}, `Homework Tablet app ${APP_VERSION}. Your homework, answers and keys stay on this phone and the tablet.`),
    h('p', {}, 'Answers are never sent to the AI unless you ask for a hint (and "Hints can look at my handwriting" is on).')));
  return frag;
}

// ------------------------------------------------------------------ boot
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => go({ name: b.dataset.tab })));
$('#tabletChip').addEventListener('click', () => {
  if (link.connected) {
    sheet(close => [h('h2', {}, 'Tablet'),
      h('p', { class: 'muted' }, link.info ? `Battery ${link.info.bat >= 0 ? link.info.bat + '%' : 'n/a'} · firmware ${link.info.fw}` : 'Connected'),
      h('button', { class: 'btn primary block', onclick: () => { close(); sync(); } }, 'Sync now'),
      h('div', { style: 'height:8px' }),
      h('button', { class: 'btn block', onclick: () => { close(); link.disconnect(); updateChip(); } }, 'Disconnect')]);
  } else connectTablet();
});
$('#syncBtn').addEventListener('click', () => (link.connected ? sync() : connectTablet()));

(async () => {
  await load();
  render();
  if (settings.canvasFeed) {
    const last = await db.get('canvasFetched', 0);
    if (Date.now() - last > 3 * 3600 * 1000) refreshCanvas(false);
  }
  // Keep the screen awake while the app is open so hints keep working (where supported).
  try { if (navigator.wakeLock) document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') navigator.wakeLock.request('screen').catch(() => {}); }); } catch (e) { /* */ }
})();

// For automated tests
window.__hw = {
  settings, link, buildManifest, cardJpeg, cardVersion, styleFor, refreshCanvas, findA: id => findA(id),
  get assignments() { return assignments; },
  async pdfBytes(id) {
    const a = findA(id); const inks = new Map();
    for (const q of a.questions || []) inks.set(q.id, await getInk(a, q));
    return buildPdf(a, { inks, getPage: n => getPageBitmap(a, n), styleFor: q => styleFor(a, q), includeOriginal: false });
  },
};
