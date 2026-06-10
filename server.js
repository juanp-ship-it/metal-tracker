const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'metaltrack.json');

// BASE_URL: en Railway se usa la variable de entorno, localmente se detecta la IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}
const LOCAL_IP = getLocalIP();
const BASE_URL = process.env.BASE_URL || `http://${LOCAL_IP}:${PORT}`;

// ── JSON DATABASE ─────────────────────────────────────────────────────────────
const EMPTY_DB = { projects: [], structures: [], components: [], history: [], workers: [], _seq: 0 };

function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) { console.error('DB read error:', e.message); }
  return JSON.parse(JSON.stringify(EMPTY_DB));
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function nextId(db) {
  db._seq = (db._seq || 0) + 1;
  return db._seq;
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ── STATUS CONFIG ─────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  pending:              { label: 'Pendiente',           color: '#6c757d', bg: '#f8f9fa',  icon: '⏳' },
  assembly_in_progress: { label: 'Armando',             color: '#0d6efd', bg: '#e7f0ff',  icon: '🔧' },
  assembly_rejected:    { label: 'Armado Rechazado',    color: '#dc3545', bg: '#fde8ea',  icon: '❌' },
  assembly_approved:    { label: 'Listo para Soldar',   color: '#0dcaf0', bg: '#e0f7fa',  icon: '✅' },
  welding_in_progress:  { label: 'Soldando',            color: '#fd7e14', bg: '#fff3e0',  icon: '🔥' },
  welding_rejected:     { label: 'Soldadura Rechazada', color: '#dc3545', bg: '#fde8ea',  icon: '❌' },
  welding_approved:     { label: 'Listo p/ Galvanizar', color: '#ffc107', bg: '#fff8e1',  icon: '✅' },
  galvanizing:          { label: 'En Galvanizado',      color: '#6f42c1', bg: '#f3effe',  icon: '⚗️' },
  galvanized:           { label: 'Listo p/ Insp. Final',color: '#0dcaf0', bg: '#e0f7fa',  icon: '🔍' },
  final_rejected:       { label: 'Insp. Final Rechazada',color:'#dc3545', bg: '#fde8ea',  icon: '❌' },
  completed:            { label: 'Completado ✓',        color: '#0f5132', bg: '#d1e7dd',  icon: '🏆' },
};

const ACTION_CONFIG = {
  start_assembly:      { label: 'Iniciar Armado',        to_status: 'assembly_in_progress', btn: 'primary',  requires_notes: false },
  approve_assembly:    { label: 'Aprobar Armado ✓',      to_status: 'assembly_approved',    btn: 'success',  requires_notes: false },
  reject_assembly:     { label: 'Rechazar Armado ✗',     to_status: 'assembly_rejected',    btn: 'danger',   requires_notes: true  },
  restart_assembly:    { label: 'Reiniciar Armado',      to_status: 'assembly_in_progress', btn: 'warning',  requires_notes: false },
  start_welding:       { label: 'Iniciar Soldadura',     to_status: 'welding_in_progress',  btn: 'primary',  requires_notes: false },
  approve_welding:     { label: 'Aprobar Soldadura ✓',   to_status: 'welding_approved',     btn: 'success',  requires_notes: false },
  reject_welding:      { label: 'Rechazar Soldadura ✗',  to_status: 'welding_rejected',     btn: 'danger',   requires_notes: true  },
  restart_welding:     { label: 'Reiniciar Soldadura',   to_status: 'welding_in_progress',  btn: 'warning',  requires_notes: false },
  send_to_galvanizing: { label: 'Enviar a Galvanizar',         to_status: 'galvanizing',    btn: 'info',    requires_notes: false },
  mark_galvanized:     { label: 'Marcar Galvanizado ✓',        to_status: 'galvanized',     btn: 'success', requires_notes: false },
  approve_final:       { label: 'Aprobar Inspección Final ✓',  to_status: 'completed',      btn: 'success', requires_notes: false },
  reject_final:        { label: 'Rechazar Inspección Final ✗', to_status: 'final_rejected', btn: 'danger',  requires_notes: true  },
  restart_final:       { label: 'Reiniciar para Inspección',   to_status: 'galvanized',     btn: 'warning', requires_notes: false },
};

const STATUS_NEXT = {
  pending:              ['start_assembly'],
  assembly_in_progress: ['approve_assembly', 'reject_assembly'],
  assembly_rejected:    ['restart_assembly'],
  assembly_approved:    ['start_welding'],
  welding_in_progress:  ['approve_welding', 'reject_welding'],
  welding_rejected:     ['restart_welding'],
  welding_approved:     ['send_to_galvanizing'],
  galvanizing:          ['mark_galvanized'],
  galvanized:           ['approve_final', 'reject_final'],
  final_rejected:       ['restart_final'],
  completed:            [],
};

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── INFO ──────────────────────────────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  res.json({ baseUrl: BASE_URL, localIP: LOCAL_IP, port: PORT, STATUS_CONFIG, ACTION_CONFIG, STATUS_NEXT });
});

// ── PROJECTS ──────────────────────────────────────────────────────────────────
app.get('/api/projects', (req, res) => {
  const db = readDB();
  const projects = db.projects.map(p => {
    const structs = db.structures.filter(s => s.project_id === p.id);
    const structIds = structs.map(s => s.id);
    const comps = db.components.filter(c => structIds.includes(c.structure_id));
    return {
      ...p,
      structure_count: structs.length,
      component_count: comps.length,
      done_count: comps.filter(c => c.status === 'galvanized').length,
    };
  }).sort((a,b) => b.id - a.id);
  res.json(projects);
});

app.get('/api/projects/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const p = db.projects.find(x => x.id === id);
  if (!p) return res.status(404).json({ error: 'Not found' });

  const structures = db.structures.filter(s => s.project_id === id).map(s => {
    const comps = db.components.filter(c => c.structure_id === s.id);
    return {
      ...s,
      component_count: comps.length,
      done_count: comps.filter(c => c.status === 'galvanized').length,
      statuses: comps.map(c => c.status).join(','),
    };
  });
  res.json({ ...p, structures });
});

app.post('/api/projects', (req, res) => {
  const { name, description, client } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  const db = readDB();
  const project = { id: nextId(db), name: name.trim(), description: description||'', client: client||'', created_at: now() };
  db.projects.push(project);
  writeDB(db);
  res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const idx = db.projects.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.projects[idx] = { ...db.projects[idx], name: req.body.name, description: req.body.description||'', client: req.body.client||'' };
  writeDB(db);
  res.json({ success: true });
});

app.delete('/api/projects/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const structIds = db.structures.filter(s => s.project_id === id).map(s => s.id);
  const compIds = db.components.filter(c => structIds.includes(c.structure_id)).map(c => c.id);
  db.history = db.history.filter(h => !compIds.includes(h.component_id));
  db.components = db.components.filter(c => !structIds.includes(c.structure_id));
  db.structures = db.structures.filter(s => s.project_id !== id);
  db.projects = db.projects.filter(p => p.id !== id);
  writeDB(db);
  res.json({ success: true });
});

// ── STRUCTURES ────────────────────────────────────────────────────────────────
app.get('/api/structures', (req, res) => {
  const db = readDB();
  const { project_id } = req.query;
  let structs = db.structures;
  if (project_id) structs = structs.filter(s => s.project_id === parseInt(project_id));
  const result = structs.map(s => {
    const proj = db.projects.find(p => p.id === s.project_id);
    const comps = db.components.filter(c => c.structure_id === s.id);
    return { ...s, project_name: proj?.name||'', component_count: comps.length, done_count: comps.filter(c=>c.status==='galvanized').length };
  });
  res.json(result);
});

app.get('/api/structures/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const s = db.structures.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const proj = db.projects.find(p => p.id === s.project_id);
  const components = db.components.filter(c => c.structure_id === id).sort((a,b)=>a.id-b.id);
  res.json({ ...s, project_name: proj?.name||'', components });
});

app.post('/api/structures', (req, res) => {
  const { project_id, name, description } = req.body;
  if (!project_id || !name?.trim()) return res.status(400).json({ error: 'project_id y nombre requeridos' });
  const db = readDB();
  const structure = { id: nextId(db), project_id: parseInt(project_id), name: name.trim(), description: description||'', created_at: now() };
  db.structures.push(structure);
  writeDB(db);
  res.json(structure);
});

app.put('/api/structures/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const idx = db.structures.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.structures[idx] = { ...db.structures[idx], name: req.body.name, description: req.body.description||'' };
  writeDB(db);
  res.json({ success: true });
});

app.delete('/api/structures/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const compIds = db.components.filter(c => c.structure_id === id).map(c => c.id);
  db.history = db.history.filter(h => !compIds.includes(h.component_id));
  db.components = db.components.filter(c => c.structure_id !== id);
  db.structures = db.structures.filter(s => s.id !== id);
  writeDB(db);
  res.json({ success: true });
});

// ── COMPONENTS ────────────────────────────────────────────────────────────────
app.get('/api/components', (req, res) => {
  const db = readDB();
  const { structure_id, project_id } = req.query;
  let comps = db.components;
  if (structure_id) comps = comps.filter(c => c.structure_id === parseInt(structure_id));
  else if (project_id) {
    const sIds = db.structures.filter(s => s.project_id === parseInt(project_id)).map(s => s.id);
    comps = comps.filter(c => sIds.includes(c.structure_id));
  }
  const result = comps.map(c => {
    const s = db.structures.find(x => x.id === c.structure_id);
    const p = db.projects.find(x => x.id === s?.project_id);
    return { ...c, structure_name: s?.name||'', project_name: p?.name||'', project_id: p?.id };
  });
  res.json(result);
});

app.get('/api/components/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const c = db.components.find(x => x.id === id);
  if (!c) return res.status(404).json({ error: 'Componente no encontrado' });
  const s = db.structures.find(x => x.id === c.structure_id);
  const p = db.projects.find(x => x.id === s?.project_id);
  const history = db.history.filter(h => h.component_id === id).sort((a,b) => b.id - a.id);
  const available_actions = (STATUS_NEXT[c.status] || []).map(k => ({ key: k, ...ACTION_CONFIG[k] }));
  const timeline = buildComponentTimeline([...history]);
  res.json({
    ...c,
    structure_name: s?.name||'', structure_id: s?.id,
    project_name: p?.name||'', project_id: p?.id, client: p?.client||'',
    history, available_actions, status_info: STATUS_CONFIG[c.status], timeline,
  });
});

app.post('/api/components', (req, res) => {
  const { structure_id, name, description } = req.body;
  if (!structure_id || !name?.trim()) return res.status(400).json({ error: 'structure_id y nombre requeridos' });
  const db = readDB();
  const component = { id: nextId(db), structure_id: parseInt(structure_id), name: name.trim(), description: description||'', status: 'pending', created_at: now() };
  db.components.push(component);
  writeDB(db);
  res.json(component);
});

app.post('/api/components/bulk', (req, res) => {
  const { structure_id, names } = req.body;
  if (!structure_id || !Array.isArray(names)) return res.status(400).json({ error: 'Invalid' });
  const db = readDB();
  const ids = [];
  for (const name of names) {
    if (!name?.trim()) continue;
    const component = { id: nextId(db), structure_id: parseInt(structure_id), name: name.trim(), description: '', status: 'pending', created_at: now() };
    db.components.push(component);
    ids.push(component.id);
  }
  writeDB(db);
  res.json({ ids });
});

app.put('/api/components/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const idx = db.components.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.components[idx] = { ...db.components[idx], name: req.body.name, description: req.body.description||'' };
  writeDB(db);
  res.json({ success: true });
});

app.delete('/api/components/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  db.history = db.history.filter(h => h.component_id !== id);
  db.components = db.components.filter(c => c.id !== id);
  writeDB(db);
  res.json({ success: true });
});

app.post('/api/components/:id/action', (req, res) => {
  const { action, worker_name, notes } = req.body;
  if (!worker_name?.trim()) return res.status(400).json({ error: 'Nombre del trabajador requerido' });

  const db = readDB();
  const id = parseInt(req.params.id);
  const idx = db.components.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Componente no encontrado' });

  const c = db.components[idx];
  const allowed = STATUS_NEXT[c.status] || [];
  if (!allowed.includes(action)) return res.status(400).json({ error: `Acción '${action}' no permitida en estado '${c.status}'` });

  const actionCfg = ACTION_CONFIG[action];
  if (actionCfg.requires_notes && !notes?.trim()) return res.status(400).json({ error: 'Notas requeridas para rechazar' });

  const to_status = actionCfg.to_status;
  db.components[idx].status = to_status;

  const entry = { id: nextId(db), component_id: id, action, worker_name: worker_name.trim(), notes: notes?.trim()||'', from_status: c.status, to_status, timestamp: now() };
  db.history.push(entry);

  if (!db.workers.find(w => w.name.toLowerCase() === worker_name.trim().toLowerCase())) {
    db.workers.push({ id: nextId(db), name: worker_name.trim(), role: 'worker' });
  }

  writeDB(db);
  res.json({ success: true, new_status: to_status, label: STATUS_CONFIG[to_status]?.label });
});

app.post('/api/components/:id/reset', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const idx = db.components.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const from = db.components[idx].status;
  db.components[idx].status = 'pending';
  db.history.push({ id: nextId(db), component_id: id, action: 'reset', worker_name: 'Admin', notes: 'Reset manual a inicio', from_status: from, to_status: 'pending', timestamp: now() });
  writeDB(db);
  res.json({ success: true });
});

app.post('/api/components/:id/undo', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const idx = db.components.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  // Find the last real action (not undo/reset entries)
  const compHistory = db.history
    .filter(h => h.component_id === id && h.action !== 'undo' && h.action !== 'reset')
    .sort((a, b) => b.id - a.id);

  if (!compHistory.length) return res.status(400).json({ error: 'No hay acciones para deshacer' });

  const lastAction = compHistory[0];
  const previousStatus = lastAction.from_status;

  if (!previousStatus) return res.status(400).json({ error: 'No se puede deshacer este paso' });

  const currentStatus = db.components[idx].status;
  db.components[idx].status = previousStatus;

  // Remove the last action from history
  const histIdx = db.history.findIndex(h => h.id === lastAction.id);
  db.history.splice(histIdx, 1);

  // Log the undo
  db.history.push({ id: nextId(db), component_id: id, action: 'undo', worker_name: 'Admin', notes: `Deshecho: ${lastAction.action} (${lastAction.worker_name})`, from_status: currentStatus, to_status: previousStatus, timestamp: now() });

  writeDB(db);
  res.json({ success: true, previous_status: previousStatus, label: STATUS_CONFIG[previousStatus]?.label });
});

// ── TIMELINE ──────────────────────────────────────────────────────────────────
function buildComponentTimeline(history) {
  const sorted = [...history].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const PHASES = [
    { key: 'assembly',  name: 'Armado',      start: 'start_assembly',      restart: 'restart_assembly', approve: 'approve_assembly', reject: 'reject_assembly' },
    { key: 'welding',   name: 'Soldadura',   start: 'start_welding',       restart: 'restart_welding',  approve: 'approve_welding',  reject: 'reject_welding'  },
    { key: 'galvanizing',  name: 'Galvanizado',        start: 'send_to_galvanizing', restart: null,          approve: 'mark_galvanized', reject: null           },
    { key: 'final',        name: 'Inspección Final',   start: 'approve_final',       restart: 'restart_final', approve: 'approve_final',   reject: 'reject_final' },
  ];

  return PHASES.map(phase => {
    const starts    = sorted.filter(h => h.action === phase.start || h.action === phase.restart);
    const approvals = sorted.filter(h => h.action === phase.approve);
    const rejects   = sorted.filter(h => h.action === phase.reject);

    if (!starts.length) return { ...phase, status: 'pending', started_at: null, completed_at: null, duration_ms: null, attempts: 0, worker: null, qc_worker: null };

    const firstStart = starts[0];
    const lastApproval = approvals[approvals.length - 1] || null;
    const attempts = sorted.filter(h => h.action === phase.start || h.action === phase.restart).length;

    let status = 'in_progress';
    if (lastApproval) status = 'completed';
    else if (rejects.length) status = 'rejected';

    const duration_ms = lastApproval ? new Date(lastApproval.timestamp) - new Date(firstStart.timestamp) : null;

    return {
      ...phase,
      status,
      started_at: firstStart.timestamp,
      completed_at: lastApproval?.timestamp || null,
      duration_ms,
      attempts,
      worker: starts[starts.length - 1]?.worker_name || null,
      qc_worker: lastApproval?.worker_name || null,
      rejects: rejects.length,
    };
  });
}

// Structure timeline: aggregate component histories
app.get('/api/structures/:id/timeline', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const s = db.structures.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: 'Not found' });

  const components = db.components.filter(c => c.structure_id === id);
  const result = components.map(c => {
    const history = db.history.filter(h => h.component_id === c.id).sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp));
    return { id: c.id, name: c.name, status: c.status, timeline: buildComponentTimeline(history) };
  });

  // Structure-level phase summary
  const PHASE_KEYS = ['assembly', 'welding', 'galvanizing'];
  const phaseSummary = PHASE_KEYS.map(key => {
    const phasesForKey = result.map(c => c.timeline.find(p => p.key === key)).filter(Boolean);
    const started = phasesForKey.filter(p => p.started_at).map(p => new Date(p.started_at));
    const completed = phasesForKey.filter(p => p.completed_at).map(p => new Date(p.completed_at));
    const allDone = phasesForKey.length > 0 && phasesForKey.every(p => p.status === 'completed');
    const anyStarted = started.length > 0;
    const firstStart = anyStarted ? new Date(Math.min(...started)).toISOString().replace('T',' ').slice(0,19) : null;
    const lastComplete = completed.length > 0 ? new Date(Math.max(...completed)).toISOString().replace('T',' ').slice(0,19) : null;
    const duration_ms = (firstStart && lastComplete) ? new Date(lastComplete) - new Date(firstStart) : null;
    return { key, firstStart, lastComplete, allDone, anyStarted, duration_ms };
  });

  res.json({ components: result, phaseSummary });
});

// ── QR CODE ───────────────────────────────────────────────────────────────────
app.get('/api/components/:id/qr', async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const baseUrl = process.env.BASE_URL || `${proto}://${host}`;
  const scanUrl = `${baseUrl}/scan.html?id=${req.params.id}`;
  const size = parseInt(req.query.size) || 200;
  try {
    const dataUrl = await QRCode.toDataURL(scanUrl, { width: size, margin: 1, errorCorrectionLevel: 'M' });
    res.json({ dataUrl, scanUrl });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WORKERS ───────────────────────────────────────────────────────────────────
app.get('/api/workers', (req, res) => {
  const db = readDB();
  res.json([...db.workers].sort((a,b) => a.name.localeCompare(b.name)));
});

app.post('/api/workers', (req, res) => {
  const { name, role } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  const db = readDB();
  if (db.workers.find(w => w.name.toLowerCase() === name.trim().toLowerCase()))
    return res.status(400).json({ error: 'Ya existe un trabajador con ese nombre' });
  const worker = { id: nextId(db), name: name.trim(), role: role||'worker' };
  db.workers.push(worker);
  writeDB(db);
  res.json(worker);
});

app.put('/api/workers/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const idx = db.workers.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.workers[idx] = { ...db.workers[idx], name: req.body.name, role: req.body.role||'worker' };
  writeDB(db);
  res.json({ success: true });
});

app.delete('/api/workers/:id', (req, res) => {
  const db = readDB();
  db.workers = db.workers.filter(w => w.id !== parseInt(req.params.id));
  writeDB(db);
  res.json({ success: true });
});

// ── REPORT ────────────────────────────────────────────────────────────────────
app.get('/api/report/project/:id', (req, res) => {
  const db = readDB();
  const pid = parseInt(req.params.id);
  const project = db.projects.find(p => p.id === pid);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const structures = db.structures.filter(s => s.project_id === pid);
  const allCompIds = [];

  const result = structures.map(s => {
    const components = db.components.filter(c => c.structure_id === s.id).sort((a,b)=>a.id-b.id);
    const compData = components.map(c => {
      allCompIds.push(c.id);
      const history = db.history.filter(h => h.component_id === c.id).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
      return { ...c, timeline: buildComponentTimeline(history) };
    });
    return { ...s, components: compData };
  });

  const statusCounts = {};
  result.flatMap(s=>s.components).forEach(c => { statusCounts[c.status]=(statusCounts[c.status]||0)+1; });

  const allDates = db.history.filter(h=>allCompIds.includes(h.component_id)).map(h=>new Date(h.timestamp));
  const minDate = allDates.length ? new Date(Math.min(...allDates)) : null;
  const maxDate = allDates.length ? new Date(Date.now()) : null;

  res.json({ project, structures: result, statusCounts, minDate, maxDate });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║    MetalTrack - Sistema de Seguimiento       ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Local:  http://localhost:${PORT}                 ║`);
  console.log(`║  Red:    http://${LOCAL_IP}:${PORT}              ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Celular: misma red WiFi, usar URL de Red    ║');
  console.log('╚══════════════════════════════════════════════╝\n');
});
