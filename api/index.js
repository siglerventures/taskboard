/**
 * Taskboard thin API — lets external assistants read & write Philinity Task Board
 * tasks over plain REST/JSON, authenticated by a static API key, WITHOUT ever
 * handing out Firebase credentials.
 *
 * The function holds the privileged access server-side (Firebase Admin SDK, which
 * bypasses the RTDB security rules) and exposes only a small, validated surface.
 * External callers hold nothing but the API key.
 *
 * It writes to the SAME paths the web app uses, preserving every invariant the
 * client depends on, so live app sessions update in real time and nothing
 * corrupts:
 *   - task id is allocated from taskboard/nextId  (atomic transaction)
 *   - new task id is prepended into taskboard/taskOrder/{cat}
 *   - completing a task prepends to taskboard/completionLog and nulls tasks/{id}
 *
 * Runtime: Firebase Cloud Functions v2 (Node 18+). See README.md for deploy steps.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

// --- API key(s) -----------------------------------------------------------
// Set with:  firebase functions:secrets:set TASKS_API_KEY
// Optional read-only key (callers may GET but not mutate).
const TASKS_API_KEY = defineSecret('TASKS_API_KEY');
const TASKS_API_READONLY_KEY = defineSecret('TASKS_API_READONLY_KEY');

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: 'https://philinity-893d2-default-rtdb.firebaseio.com',
  });
}

const ROOT = 'taskboard';
const PRIORITIES = ['high', 'medium', 'low'];
const MAX_TEXT = 2000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function db() { return admin.database(); }
function ref(path) { return db().ref(ROOT + (path ? '/' + path : '')); }

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Mirrors index.html getDefaultAssignee(): default assignee derives from the
// category label (Trinity / Austen), otherwise Phil.
function getDefaultAssignee(catId, categories) {
  const cat = categories && categories[catId];
  const label = (cat ? cat.label : catId || '').toLowerCase();
  if (label === 'trinity') return 'Trinity';
  if (label === 'austen' || label === 'austin') return 'Austen';
  return 'Phil';
}

async function readCategories() {
  const snap = await ref('categories').get();
  return snap.val() || {};
}

async function readTasksArray() {
  const snap = await ref('tasks').get();
  const map = snap.val() || {};
  return Object.keys(map).map((k) => map[k]).filter(Boolean);
}

// Allocate the next task id atomically, exactly like the client's `nextId++`:
// the returned id is the value BEFORE increment (floor 100).
async function allocateId() {
  let allocated = null;
  await ref('nextId').transaction((cur) => {
    const n = typeof cur === 'number' && cur >= 100 ? cur : 100;
    allocated = n;
    return n + 1;
  });
  return allocated;
}

// Prepend id into taskOrder/{cat} (client uses unshift → newest on top).
async function prependToOrder(cat, id) {
  await ref('taskOrder/' + cat).transaction((cur) => {
    const arr = Array.isArray(cur) ? cur.slice() : [];
    if (!arr.includes(id)) arr.unshift(id);
    return arr;
  });
}

async function removeFromOrder(cat, id) {
  await ref('taskOrder/' + cat).transaction((cur) => {
    if (!Array.isArray(cur)) return cur;
    return cur.filter((x) => x !== id);
  });
}

// Prepend an entry onto completionLog (client uses unshift → newest first).
async function prependToLog(entry) {
  await ref('completionLog').transaction((cur) => {
    let arr;
    if (Array.isArray(cur)) arr = cur.slice();
    else if (cur && typeof cur === 'object') arr = Object.keys(cur).map((k) => cur[k]);
    else arr = [];
    arr.unshift(entry);
    return arr;
  });
}

// ---------------------------------------------------------------------------
// tiny router (no express dependency — keeps the function lean)
// ---------------------------------------------------------------------------
function send(res, status, body) {
  res.status(status).json(body);
}
function ok(res, data, status = 200) { send(res, status, { ok: true, data }); }
function err(res, status, code, message) { send(res, status, { ok: false, error: { code, message } }); }

function normalizeTaskInput(body, categories, existing) {
  const out = {};
  let text = body.text;
  if (text !== undefined) {
    if (typeof text !== 'string' || !text.trim()) return { error: 'text must be a non-empty string' };
    if (text.length > MAX_TEXT) return { error: `text exceeds ${MAX_TEXT} chars` };
    out.text = text.trim();
  }
  if (body.cat !== undefined) {
    if (!categories[body.cat]) return { error: `unknown category '${body.cat}'` };
    out.cat = body.cat;
    out.col = body.cat; // board column always tracks category
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) return { error: `priority must be one of ${PRIORITIES.join(', ')}` };
    out.priority = body.priority;
  }
  if (body.assignee !== undefined) {
    if (typeof body.assignee !== 'string' || !body.assignee.trim()) return { error: 'assignee must be a non-empty string' };
    out.assignee = body.assignee.trim();
  }
  // reject unknown fields to fail loud on typos
  const allowed = new Set(['text', 'cat', 'priority', 'assignee']);
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length && !existing) return { error: `unexpected field(s): ${unknown.join(', ')}` };
  return { value: out };
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------
async function handleMeta(req, res) {
  const categories = await readCategories();
  const peopleSnap = await ref('people').get();
  const cats = Object.keys(categories).map((id) => ({
    id,
    label: categories[id] && categories[id].label,
    archived: !!(categories[id] && categories[id].archived),
  }));
  ok(res, { categories: cats, people: peopleSnap.val() || [], priorities: PRIORITIES });
}

async function handleListTasks(req, res) {
  let tasks = await readTasksArray();
  const { cat, assignee, priority } = req.query;
  if (cat) tasks = tasks.filter((t) => t.cat === cat);
  if (priority) tasks = tasks.filter((t) => (t.priority || 'medium') === priority);
  if (assignee) tasks = tasks.filter((t) => (t.assignee || '').toLowerCase() === String(assignee).toLowerCase());
  ok(res, { count: tasks.length, tasks });
}

async function handleGetTask(req, res, id) {
  const snap = await ref('tasks/' + id).get();
  const task = snap.val();
  if (!task) return err(res, 404, 'not_found', `task ${id} not found`);
  ok(res, { task });
}

async function handleCreateTask(req, res) {
  const categories = await readCategories();
  const catIds = Object.keys(categories);
  if (!req.body || typeof req.body !== 'object') return err(res, 400, 'bad_request', 'JSON body required');

  const parsed = normalizeTaskInput(req.body, categories, false);
  if (parsed.error) return err(res, 400, 'validation', parsed.error);
  const input = parsed.value;

  if (!input.text) return err(res, 400, 'validation', 'text is required');
  const cat = input.cat || catIds[0];
  if (!cat) return err(res, 409, 'no_categories', 'board has no categories to file the task under');

  const id = await allocateId();
  const task = {
    id,
    text: input.text,
    cat,
    col: cat,
    priority: input.priority || 'medium',
    assignee: input.assignee || getDefaultAssignee(cat, categories),
    dateAdded: new Date().toISOString(),
  };
  await ref('tasks/' + id).set(task);
  await prependToOrder(cat, id);
  ok(res, { task }, 201);
}

async function handleUpdateTask(req, res, id) {
  const snap = await ref('tasks/' + id).get();
  const task = snap.val();
  if (!task) return err(res, 404, 'not_found', `task ${id} not found`);

  const categories = await readCategories();
  const parsed = normalizeTaskInput(req.body || {}, categories, true);
  if (parsed.error) return err(res, 400, 'validation', parsed.error);
  const changes = parsed.value;
  if (!Object.keys(changes).length) return err(res, 400, 'validation', 'no updatable fields provided');

  const oldCat = task.cat;
  const merged = Object.assign({}, task, changes);
  await ref('tasks/' + id).update(changes);

  // Category moved → keep taskOrder columns consistent with the board.
  if (changes.cat && changes.cat !== oldCat) {
    await removeFromOrder(oldCat, task.id);
    await prependToOrder(changes.cat, task.id);
  }
  ok(res, { task: merged });
}

async function handleCompleteTask(req, res, id) {
  const snap = await ref('tasks/' + id).get();
  const task = snap.val();
  if (!task) return err(res, 404, 'not_found', `task ${id} not found`);
  const categories = await readCategories();

  const entry = {
    id: task.id,
    text: task.text,
    cat: task.cat,
    assignee: task.assignee || getDefaultAssignee(task.cat, categories),
    completedAt: new Date().toISOString(),
    dateAdded: task.dateAdded || null,
    priority: task.priority || 'medium',
  };
  await prependToLog(entry);
  await ref('tasks/' + id).set(null);
  await removeFromOrder(task.cat, task.id);
  ok(res, { completed: entry });
}

async function handleDeleteTask(req, res, id) {
  const snap = await ref('tasks/' + id).get();
  const task = snap.val();
  if (!task) return err(res, 404, 'not_found', `task ${id} not found`);
  await ref('tasks/' + id).set(null);
  await removeFromOrder(task.cat, task.id);
  ok(res, { deleted: id });
}

async function handleHistory(req, res) {
  const snap = await ref('completionLog').get();
  const raw = snap.val();
  let log = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.keys(raw).map((k) => raw[k]) : [];
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 2000);
  ok(res, { count: log.length, returned: Math.min(limit, log.length), history: log.slice(0, limit) });
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------
exports.tasksApi = onRequest(
  { region: 'us-central1', secrets: [TASKS_API_KEY, TASKS_API_READONLY_KEY], cors: true },
  async (req, res) => {
    try {
      // --- auth ---
      const hdr = req.get('authorization') || '';
      const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
      const provided = bearer || req.get('x-api-key') || '';
      const rwKey = TASKS_API_KEY.value();
      const roKey = TASKS_API_READONLY_KEY.value();

      const isRW = rwKey && timingSafeEqual(provided, rwKey);
      const isRO = roKey && timingSafeEqual(provided, roKey);
      if (!isRW && !isRO) return err(res, 401, 'unauthorized', 'valid API key required');

      const method = req.method.toUpperCase();
      const isWrite = method !== 'GET' && method !== 'HEAD';
      if (isWrite && !isRW) return err(res, 403, 'forbidden', 'this key is read-only');

      // --- route ---  path is after the function name, e.g. /tasks/105/complete
      const path = (req.path || '/').replace(/\/+$/, '') || '/';
      const parts = path.split('/').filter(Boolean); // ['tasks','105','complete']

      if (parts[0] === 'meta' && method === 'GET') return await handleMeta(req, res);
      if (parts[0] === 'history' && method === 'GET') return await handleHistory(req, res);

      if (parts[0] === 'tasks') {
        const id = parts[1] ? parseInt(parts[1], 10) : null;
        if (id !== null && Number.isNaN(id)) return err(res, 400, 'bad_request', 'task id must be numeric');

        if (!parts[1]) {
          if (method === 'GET') return await handleListTasks(req, res);
          if (method === 'POST') return await handleCreateTask(req, res);
          return err(res, 405, 'method_not_allowed', `${method} /tasks not supported`);
        }
        if (parts[2] === 'complete' && method === 'POST') return await handleCompleteTask(req, res, id);
        if (!parts[2]) {
          if (method === 'GET') return await handleGetTask(req, res, id);
          if (method === 'PATCH' || method === 'PUT') return await handleUpdateTask(req, res, id);
          if (method === 'DELETE') return await handleDeleteTask(req, res, id);
        }
        return err(res, 405, 'method_not_allowed', `${method} ${path} not supported`);
      }

      return err(res, 404, 'not_found', `no route for ${method} ${path}`);
    } catch (e) {
      console.error('tasksApi error', e);
      return err(res, 500, 'internal', 'internal error');
    }
  }
);
