const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

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

// ── MONGOOSE SCHEMAS ──────────────────────────────────────────────────────────
mongoose.plugin(schema => { schema.set('toJSON', { virtuals: false }); schema.set('toObject', { virtuals: false }); });
const opts = { id: false };

const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const Counter = mongoose.model('Counter', counterSchema);

async function nextId(name) {
  const doc = await Counter.findByIdAndUpdate(name, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return doc.seq;
}

const projectSchema = new mongoose.Schema({ id: Number, name: String, description: String, client: String, created_at: String }, opts);
const Project = mongoose.model('Project', projectSchema);

const structureSchema = new mongoose.Schema({ id: Number, project_id: Number, name: String, description: String, created_at: String }, opts);
const Structure = mongoose.model('Structure', structureSchema);

const componentSchema = new mongoose.Schema({ id: Number, structure_id: Number, name: String, description: String, status: String, created_at: String, heat_number: String, sub_components: [{ name: String, heat_number: String, po: String }] }, opts);
const Component = mongoose.model('Component', componentSchema);

const historySchema = new mongoose.Schema({ id: Number, component_id: Number, action: String, worker_name: String, notes: String, from_status: String, to_status: String, timestamp: String }, opts);
const History = mongoose.model('History', historySchema);

const workerSchema = new mongoose.Schema({ id: Number, name: String, role: String }, opts);
const Worker = mongoose.model('Worker', workerSchema);

function now() {
  return new Date().toLocaleString('es-CO', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(',', '');
}

// ── STATUS CONFIG ─────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  pending:              { label: 'Pendiente',            color: '#6c757d', bg: '#f8f9fa'  },
  assembly_in_progress: { label: 'Armando',              color: '#0d6efd', bg: '#e7f0ff'  },
  assembly_rejected:    { label: 'Armado Rechazado',     color: '#dc3545', bg: '#fde8ea'  },
  assembly_approved:    { label: 'Listo para Soldar',    color: '#0dcaf0', bg: '#e0f7fa'  },
  welding_in_progress:  { label: 'Soldando',             color: '#fd7e14', bg: '#fff3e0'  },
  welding_rejected:     { label: 'Soldadura Rechazada',  color: '#dc3545', bg: '#fde8ea'  },
  welding_approved:     { label: 'Listo p/ Galvanizar',  color: '#ffc107', bg: '#fff8e1'  },
  galvanizing:          { label: 'En Galvanizado',       color: '#6f42c1', bg: '#f3effe'  },
  galvanized:           { label: 'Listo p/ Insp. Final', color: '#0dcaf0', bg: '#e0f7fa'  },
  final_rejected:       { label: 'Insp. Final Rechazada',color: '#dc3545', bg: '#fde8ea'  },
  completed:            { label: 'Completado',           color: '#0f5132', bg: '#d1e7dd'  },
};

const ACTION_CONFIG = {
  start_assembly:      { label: 'Iniciar Armado',               to_status: 'assembly_in_progress', btn: 'primary',  requires_notes: false },
  approve_assembly:    { label: 'Aprobar Armado',               to_status: 'assembly_approved',    btn: 'success',  requires_notes: false },
  reject_assembly:     { label: 'Rechazar Armado',              to_status: 'assembly_rejected',    btn: 'danger',   requires_notes: true  },
  restart_assembly:    { label: 'Reiniciar Armado',             to_status: 'assembly_in_progress', btn: 'warning',  requires_notes: false },
  start_welding:       { label: 'Iniciar Soldadura',            to_status: 'welding_in_progress',  btn: 'primary',  requires_notes: false },
  approve_welding:     { label: 'Aprobar Soldadura',            to_status: 'welding_approved',     btn: 'success',  requires_notes: false },
  reject_welding:      { label: 'Rechazar Soldadura',           to_status: 'welding_rejected',     btn: 'danger',   requires_notes: true  },
  restart_welding:     { label: 'Reiniciar Soldadura',          to_status: 'welding_in_progress',  btn: 'warning',  requires_notes: false },
  send_to_galvanizing: { label: 'Enviar a Galvanizar',          to_status: 'galvanizing',          btn: 'info',     requires_notes: false },
  mark_galvanized:     { label: 'Marcar Galvanizado',           to_status: 'galvanized',           btn: 'success',  requires_notes: false },
  approve_final:       { label: 'Aprobar Inspeccion Final',     to_status: 'completed',            btn: 'success',  requires_notes: false },
  reject_final:        { label: 'Rechazar Inspeccion Final',    to_status: 'final_rejected',       btn: 'danger',   requires_notes: true  },
  restart_final:       { label: 'Reiniciar para Inspeccion',   to_status: 'galvanized',           btn: 'warning',  requires_notes: false },
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

// ── DEBUG ─────────────────────────────────────────────────────────────────────


// ── AUTH ──────────────────────────────────────────────────────────────────────
const HEAT_PASSWORD = process.env.HEAT_PASSWORD || 'braulio2024';

app.post('/api/auth/heat', (req, res) => {
  const { password } = req.body;
  if (password === HEAT_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Contrasena incorrecta' });
});

// ── INFO ──────────────────────────────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  res.json({ baseUrl: BASE_URL, localIP: LOCAL_IP, port: PORT, STATUS_CONFIG, ACTION_CONFIG, STATUS_NEXT });
});

// ── PROJECTS ──────────────────────────────────────────────────────────────────
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await Project.find().lean().sort({ id: -1 });
    const structures = await Structure.find().lean();
    const components = await Component.find().lean();
    const result = projects.map(p => {
      const structs = structures.filter(s => s.project_id === p.id);
      const sIds = structs.map(s => s.id);
      const comps = components.filter(c => sIds.includes(c.structure_id));
      return { ...p, structure_count: structs.length, component_count: comps.length, done_count: comps.filter(c => c.status === 'completed').length };
    });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const p = await Project.findOne({ id }).lean();
    if (!p) return res.status(404).json({ error: 'Not found' });
    const structures = await Structure.find({ project_id: id }).lean();
    const components = await Component.find().lean();
    const result = structures.map(s => {
      const comps = components.filter(c => c.structure_id === s.id);
      return { ...s, component_count: comps.length, done_count: comps.filter(c => c.status === 'completed').length, statuses: comps.map(c => c.status).join(',') };
    });
    res.json({ ...p, structures: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const { name, description, client } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    const id = await nextId('project');
    const project = await Project.create({ id, name: name.trim(), description: description||'', client: client||'', created_at: now() });
    res.json(project);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await Project.findOneAndUpdate({ id }, { name: req.body.name, description: req.body.description||'', client: req.body.client||'' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const structs = await Structure.find({ project_id: id }).lean();
    const sIds = structs.map(s => s.id);
    const comps = await Component.find({ structure_id: { $in: sIds } }).lean();
    const cIds = comps.map(c => c.id);
    await History.deleteMany({ component_id: { $in: cIds } });
    await Component.deleteMany({ structure_id: { $in: sIds } });
    await Structure.deleteMany({ project_id: id });
    await Project.deleteOne({ id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STRUCTURES ────────────────────────────────────────────────────────────────
app.get('/api/structures', async (req, res) => {
  try {
    const { project_id } = req.query;
    const filter = project_id ? { project_id: parseInt(project_id) } : {};
    const structs = await Structure.find(filter).lean();
    const projects = await Project.find().lean();
    const components = await Component.find().lean();
    const result = structs.map(s => {
      const proj = projects.find(p => p.id === s.project_id);
      const comps = components.filter(c => c.structure_id === s.id);
      return { ...s, project_name: proj?.name||'', component_count: comps.length, done_count: comps.filter(c => c.status === 'completed').length };
    });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/structures/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const s = await Structure.findOne({ id }).lean();
    if (!s) return res.status(404).json({ error: 'Not found' });
    const proj = await Project.findOne({ id: s.project_id }).lean();
    const components = await Component.find({ structure_id: id }).lean().sort({ id: 1 });
    res.json({ ...s, project_name: proj?.name||'', components });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/structures', async (req, res) => {
  try {
    const { project_id, name, description } = req.body;
    if (!project_id || !name?.trim()) return res.status(400).json({ error: 'project_id y nombre requeridos' });
    const id = await nextId('structure');
    const structure = await Structure.create({ id, project_id: parseInt(project_id), name: name.trim(), description: description||'', created_at: now() });
    res.json(structure);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/structures/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await Structure.findOneAndUpdate({ id }, { name: req.body.name, description: req.body.description||'' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/structures/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const comps = await Component.find({ structure_id: id }).lean();
    const cIds = comps.map(c => c.id);
    await History.deleteMany({ component_id: { $in: cIds } });
    await Component.deleteMany({ structure_id: id });
    await Structure.deleteOne({ id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── COMPONENTS ────────────────────────────────────────────────────────────────
app.get('/api/components', async (req, res) => {
  try {
    const { structure_id, project_id } = req.query;
    let filter = {};
    if (structure_id) filter.structure_id = parseInt(structure_id);
    else if (project_id) {
      const sIds = (await Structure.find({ project_id: parseInt(project_id) }).lean()).map(s => s.id);
      filter.structure_id = { $in: sIds };
    }
    const comps = await Component.find(filter).lean();
    const structures = await Structure.find().lean();
    const projects = await Project.find().lean();
    const result = comps.map(c => {
      const s = structures.find(x => x.id === c.structure_id);
      const p = projects.find(x => x.id === s?.project_id);
      return { ...c, structure_name: s?.name||'', project_name: p?.name||'', project_id: p?.id };
    });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/components/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const c = await Component.findOne({ id }).lean();
    if (!c) return res.status(404).json({ error: 'Componente no encontrado' });
    const s = await Structure.findOne({ id: c.structure_id }).lean();
    const p = await Project.findOne({ id: s?.project_id }).lean();
    const history = await History.find({ component_id: id }).lean().sort({ id: -1 });
    const available_actions = (STATUS_NEXT[c.status] || []).map(k => ({ key: k, ...ACTION_CONFIG[k] }));
    const timeline = buildComponentTimeline([...history]);
    res.json({
      ...c,
      structure_name: s?.name||'', structure_id: s?.id,
      project_name: p?.name||'', project_id: p?.id, client: p?.client||'',
      history, available_actions, status_info: STATUS_CONFIG[c.status], timeline,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/components', async (req, res) => {
  try {
    const { structure_id, name, description } = req.body;
    if (!structure_id || !name?.trim()) return res.status(400).json({ error: 'structure_id y nombre requeridos' });
    const id = await nextId('component');
    const component = await Component.create({ id, structure_id: parseInt(structure_id), name: name.trim(), description: description||'', status: 'pending', created_at: now() });
    res.json(component);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/components/bulk', async (req, res) => {
  try {
    const { structure_id, names } = req.body;
    if (!structure_id || !Array.isArray(names)) return res.status(400).json({ error: 'Invalid' });
    const ids = [];
    for (const name of names) {
      if (!name?.trim()) continue;
      const id = await nextId('component');
      await Component.create({ id, structure_id: parseInt(structure_id), name: name.trim(), description: '', status: 'pending', created_at: now() });
      ids.push(id);
    }
    res.json({ ids });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/components/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await Component.findOneAndUpdate({ id }, { name: req.body.name, description: req.body.description||'' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/components/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await History.deleteMany({ component_id: id });
    await Component.deleteOne({ id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/components/:id/action', async (req, res) => {
  try {
    const { action, worker_name, notes } = req.body;
    if (!worker_name?.trim()) return res.status(400).json({ error: 'Nombre del trabajador requerido' });

    const id = parseInt(req.params.id);
    const c = await Component.findOne({ id }).lean();
    if (!c) return res.status(404).json({ error: 'Componente no encontrado' });

    const allowed = STATUS_NEXT[c.status] || [];
    if (!allowed.includes(action)) return res.status(400).json({ error: `Accion '${action}' no permitida en estado '${c.status}'` });

    const actionCfg = ACTION_CONFIG[action];
    if (actionCfg.requires_notes && !notes?.trim()) return res.status(400).json({ error: 'Notas requeridas para rechazar' });

    const to_status = actionCfg.to_status;
    await Component.findOneAndUpdate({ id }, { status: to_status });

    const hid = await nextId('history');
    await History.create({ id: hid, component_id: id, action, worker_name: worker_name.trim(), notes: notes?.trim()||'', from_status: c.status, to_status, timestamp: now() });

    const wname = worker_name.trim();
    const existing = await Worker.findOne({ name: { $regex: `^${wname}$`, $options: 'i' } }).lean();
    if (!existing) {
      const wid = await nextId('worker');
      await Worker.create({ id: wid, name: worker_name.trim(), role: 'worker' });
    }

    res.json({ success: true, new_status: to_status, label: STATUS_CONFIG[to_status]?.label });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/components/:id/heat', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { heat_number, notes } = req.body;
    const c = await Component.findOne({ id }).lean();
    if (!c) return res.status(404).json({ error: 'Componente no encontrado' });
    await Component.findOneAndUpdate({ id }, { heat_number: heat_number?.trim() || '' });
    if (notes?.trim()) {
      const hid = await nextId('history');
      await History.create({ id: hid, component_id: id, action: 'heat_update', worker_name: 'Braulio', notes: `Heat Number: ${heat_number?.trim()} ${notes.trim() ? '| ' + notes.trim() : ''}`, from_status: c.status, to_status: c.status, timestamp: now() });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/components/:id/subcomponents', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { sub_components, worker_name } = req.body;
    if (!Array.isArray(sub_components)) return res.status(400).json({ error: 'Invalid data' });
    const clean = sub_components.map(s => ({
      name: (s.name || '').trim(),
      heat_number: (s.heat_number || '').trim(),
      po: (s.po || '').trim()
    })).filter(s => s.name);
    await Component.findOneAndUpdate({ id }, { sub_components: clean });
    const hid = await nextId('history');
    await History.create({ id: hid, component_id: id, action: 'heat_update', worker_name: worker_name || 'Braulio', notes: `Piezas actualizadas: ${clean.length} registros`, from_status: 'n/a', to_status: 'n/a', timestamp: now() });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/components/:id/reset', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const c = await Component.findOne({ id }).lean();
    if (!c) return res.status(404).json({ error: 'Not found' });
    await Component.findOneAndUpdate({ id }, { status: 'pending' });
    const hid = await nextId('history');
    await History.create({ id: hid, component_id: id, action: 'reset', worker_name: 'Admin', notes: 'Reset manual a inicio', from_status: c.status, to_status: 'pending', timestamp: now() });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/components/:id/undo', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const c = await Component.findOne({ id }).lean();
    if (!c) return res.status(404).json({ error: 'Not found' });

    const compHistory = await History.find({ component_id: id, action: { $nin: ['undo','reset'] } }).lean().sort({ id: -1 });
    if (!compHistory.length) return res.status(400).json({ error: 'No hay acciones para deshacer' });

    const lastAction = compHistory[0];
    const previousStatus = lastAction.from_status;
    if (!previousStatus) return res.status(400).json({ error: 'No se puede deshacer este paso' });

    const currentStatus = c.status;
    await Component.findOneAndUpdate({ id }, { status: previousStatus });
    await History.deleteOne({ id: lastAction.id });

    const hid = await nextId('history');
    await History.create({ id: hid, component_id: id, action: 'undo', worker_name: 'Admin', notes: `Deshecho: ${lastAction.action} (${lastAction.worker_name})`, from_status: currentStatus, to_status: previousStatus, timestamp: now() });

    res.json({ success: true, previous_status: previousStatus, label: STATUS_CONFIG[previousStatus]?.label });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TIMELINE ──────────────────────────────────────────────────────────────────
function buildComponentTimeline(history) {
  const sorted = [...history].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const PHASES = [
    { key: 'assembly',    name: 'Armado',           start: 'start_assembly',      restart: 'restart_assembly', approve: 'approve_assembly', reject: 'reject_assembly' },
    { key: 'welding',     name: 'Soldadura',         start: 'start_welding',       restart: 'restart_welding',  approve: 'approve_welding',  reject: 'reject_welding'  },
    { key: 'galvanizing', name: 'Galvanizado',       start: 'send_to_galvanizing', restart: null,               approve: 'mark_galvanized',  reject: null              },
    { key: 'final',       name: 'Inspeccion Final',  start: 'approve_final',       restart: 'restart_final',    approve: 'approve_final',    reject: 'reject_final'    },
  ];

  return PHASES.map(phase => {
    const starts    = sorted.filter(h => h.action === phase.start || h.action === phase.restart);
    const approvals = sorted.filter(h => h.action === phase.approve);
    const rejects   = sorted.filter(h => h.action === phase.reject);

    if (!starts.length) return { ...phase, status: 'pending', started_at: null, completed_at: null, duration_ms: null, attempts: 0, worker: null, qc_worker: null };

    const firstStart = starts[0];
    const lastApproval = approvals[approvals.length - 1] || null;
    const attempts = starts.length;

    let status = 'in_progress';
    if (lastApproval) status = 'completed';
    else if (rejects.length) status = 'rejected';

    const duration_ms = lastApproval ? new Date(lastApproval.timestamp) - new Date(firstStart.timestamp) : null;

    return {
      ...phase, status,
      started_at: firstStart.timestamp,
      completed_at: lastApproval?.timestamp || null,
      duration_ms, attempts,
      worker: starts[starts.length - 1]?.worker_name || null,
      qc_worker: lastApproval?.worker_name || null,
      rejects: rejects.length,
    };
  });
}

app.get('/api/structures/:id/timeline', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const s = await Structure.findOne({ id }).lean();
    if (!s) return res.status(404).json({ error: 'Not found' });

    const components = await Component.find({ structure_id: id }).lean();
    const result = await Promise.all(components.map(async c => {
      const history = await History.find({ component_id: c.id }).lean().sort({ id: 1 });
      return { id: c.id, name: c.name, status: c.status, timeline: buildComponentTimeline(history) };
    }));

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
  } catch(e) { res.status(500).json({ error: e.message }); }
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
app.get('/api/workers', async (req, res) => {
  try {
    const workers = await Worker.find().lean().sort({ name: 1 });
    res.json(workers);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/workers', async (req, res) => {
  try {
    const { name, role } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    const wname2 = name.trim();
    const existing = await Worker.findOne({ name: { $regex: `^${wname2}$`, $options: 'i' } }).lean();
    if (existing) return res.status(400).json({ error: 'Ya existe un trabajador con ese nombre' });
    const id = await nextId('worker');
    const worker = await Worker.create({ id, name: name.trim(), role: role||'worker' });
    res.json(worker);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/workers/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await Worker.findOneAndUpdate({ id }, { name: req.body.name, role: req.body.role||'worker' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/workers/:id', async (req, res) => {
  try {
    await Worker.deleteOne({ id: parseInt(req.params.id) });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── REPORT ────────────────────────────────────────────────────────────────────
app.get('/api/report/project/:id', async (req, res) => {
  try {
    const pid = parseInt(req.params.id);
    const project = await Project.findOne({ id: pid }).lean();
    if (!project) return res.status(404).json({ error: 'Not found' });

    const structures = await Structure.find({ project_id: pid }).lean();
    const allCompIds = [];

    const result = await Promise.all(structures.map(async s => {
      const components = await Component.find({ structure_id: s.id }).lean().sort({ id: 1 });
      const compData = await Promise.all(components.map(async c => {
        allCompIds.push(c.id);
        const history = await History.find({ component_id: c.id }).lean().sort({ id: 1 });
        return { ...c, timeline: buildComponentTimeline(history) };
      }));
      return { ...s, components: compData };
    }));

    const statusCounts = {};
    result.flatMap(s => s.components).forEach(c => { statusCounts[c.status] = (statusCounts[c.status]||0)+1; });

    const allHistory = await History.find({ component_id: { $in: allCompIds } }).lean();
    const allDates = allHistory.map(h => new Date(h.timestamp));
    const minDate = allDates.length ? new Date(Math.min(...allDates)) : null;
    const maxDate = allDates.length ? new Date(Date.now()) : null;

    res.json({ project, structures: result, statusCounts, minDate, maxDate });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────────────────────────────────────
async function start() {
  if (MONGO_URI) {
    await mongoose.connect(MONGO_URI);
    console.log('Conectado a MongoDB Atlas');
  } else {
    console.warn('MONGO_URI no definida — la base de datos no funcionara en produccion');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MetalTrack corriendo en http://localhost:${PORT}`);
  });
}

start().catch(console.error);
