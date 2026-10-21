// Мок-бэкенд конструктора варианта ЕГЭ. Без зависимостей: node mock/server.mjs
// Состояние в памяти: перезапуск сервера всё сбрасывает. Документация — docs/API.md.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { buildCatalog, buildTaskContent, drawingSvg, rng } from "./data.mjs";

const PORT = Number(process.env.PORT || 4010);
const MAX_RUNNING = 2;
const CATALOG = buildCatalog();
const TYPES = new Map(CATALOG.tasks.flatMap((t) => t.types.map((type) => [type.id, type])));
const LINE = new Map(CATALOG.tasks.map((t) => [t.number, t]));

const DEFAULT_FAULTS = {
  speed: Number(process.env.MOCK_SPEED || 3), // 1 — как на проде (30–120 с на задание)
  failRate: 0.05,
  failNext: 0,
  dropRate: 0.15,
  dropAfterEvents: 0,
  imageMissingRate: 0.03,
  issueRate: 0.03,
};
let faults = { ...DEFAULT_FAULTS };
let random = rng(Number(process.env.MOCK_SEED || 42));

const variants = new Map();
const jobs = new Map();
const queue = [];
const missingAssets = new Set();
let running = 0;

const FAILURES = [
  { code: "schema_violation", message: "Модель трижды нарушила схему постановки", retriable: true },
  { code: "math_rejected", message: "Постановка не прошла независимую проверку: условие и ответ расходятся", retriable: true },
  { code: "llm_unavailable", message: "Сервис генерации временно недоступен", retriable: true },
];
const STAGES = [
  ["author", "Модель пишет постановку", 0.45],
  ["compute", "Код считает ответ", 0.1],
  ["judge", "Проверка условия вторым запросом", 0.35],
  ["render", "Подготовка формул и чертежа", 0.1],
];

// ---------- HTTP-утилиты ----------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...cors(), ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };
}
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Тело запроса — не JSON"), { status: 400 });
  }
}
const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, extra });

// ---------- Варианты ----------

function publicVariant(v) {
  return {
    id: v.id, title: v.title, revision: v.revision, status: v.status, createdAt: v.createdAt,
    updatedAt: v.updatedAt, tasks: Object.values(v.tasks).sort((a, b) => a.number - b.number).map(publicTask),
  };
}
function publicTask(t) {
  const { _seed, _checked, ...rest } = t;
  return rest;
}
function touch(v) {
  v.revision += 1;
  v.updatedAt = new Date().toISOString();
}
function variantOr404(id) {
  const v = variants.get(id);
  if (!v) throw fail(404, "not_found", "Вариант не найден");
  return v;
}
function requireRevision(v, revision) {
  if (v.status === "published") throw fail(423, "published", "Вариант уже выдан ученикам и не меняется");
  if (revision !== v.revision) {
    throw fail(409, "revision_conflict", "Вариант изменён в другом месте", { current: publicVariant(v) });
  }
}

// ---------- Генерация ----------

function chooseType(number, typeIds) {
  const line = LINE.get(number);
  if (!line) throw fail(400, "bad_number", `Нет задания №${number}`);
  if (typeIds && typeIds.length) {
    for (const id of typeIds) {
      if (TYPES.get(id)?.number !== number) throw fail(400, "bad_type", `Тип ${id} не относится к заданию №${number}`);
    }
    return TYPES.get(typeIds[Math.floor(random() * typeIds.length)]);
  }
  // Без явного выбора — только проверенные типы: экспериментальные выбирает учитель сам.
  const verified = line.types.filter((t) => !t.experimental);
  return verified[Math.floor(random() * verified.length)];
}

function startJob(v, items) {
  const job = { id: randomUUID(), variantId: v.id, numbers: items.map((i) => i.number), events: [], listeners: new Set(),
    status: "running", canceled: false, createdAt: new Date().toISOString() };
  jobs.set(job.id, job);
  for (const item of items) {
    const type = chooseType(item.number, item.typeIds);
    const prev = v.tasks[item.number];
    v.tasks[item.number] = {
      number: item.number, typeId: type.id, typeTitle: type.title, experimental: type.experimental,
      hint: item.hint || null, status: "queued", stage: null, stageTitle: null, progress: 0,
      taskRevision: (prev?.taskRevision || 0) + 1, jobId: job.id, content: null, failure: null,
      confirmation: null, issues: [], points: LINE.get(item.number).points, _seed: Math.floor(random() * 1e9),
    };
    queue.push({ jobId: job.id, variantId: v.id, number: item.number, taskRevision: v.tasks[item.number].taskRevision });
  }
  touch(v);
  emit(job, "job", { status: "running", numbers: job.numbers, variantRevision: v.revision });
  pump();
  return job;
}

function emit(job, event, data) {
  const entry = { id: job.events.length + 1, event, data: { jobId: job.id, ...data } };
  job.events.push(entry);
  for (const listener of job.listeners) listener(entry);
}

function taskEvent(job, v, task) {
  emit(job, "task", { variantRevision: v.revision, task: publicTask(task) });
}

function current(slot) {
  const v = variants.get(slot.variantId);
  const task = v?.tasks[slot.number];
  // Задание перегенерировали или удалили, пока слот ждал: старый слот молча отбрасывается.
  return task && task.taskRevision === slot.taskRevision ? { v, task } : null;
}

function pump() {
  while (running < MAX_RUNNING && queue.length) {
    const slot = queue.shift();
    const found = current(slot);
    const job = jobs.get(slot.jobId);
    if (!found || !job) continue;
    if (job.canceled) {
      found.task.status = "canceled";
      touch(found.v);
      taskEvent(job, found.v, found.task);
      finishIfDone(job);
      continue;
    }
    running += 1;
    runTask(slot, job).finally(() => {
      running -= 1;
      pump();
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTask(slot, job) {
  const totalMs = (30000 + random() * 90000) / Math.max(faults.speed, 0.1);
  const failAt = faults.failNext > 0 ? (faults.failNext--, Math.floor(random() * STAGES.length))
    : random() < faults.failRate ? Math.floor(random() * STAGES.length) : -1;
  for (let i = 0; i < STAGES.length; i++) {
    const [stage, title, share] = STAGES[i];
    let found = current(slot);
    if (!found) return finishIfDone(job);
    if (job.canceled) {
      found.task.status = "canceled";
      touch(found.v);
      taskEvent(job, found.v, found.task);
      return finishIfDone(job);
    }
    Object.assign(found.task, { status: "running", stage, stageTitle: title });
    const stageMs = totalMs * share;
    const ticks = Math.max(1, Math.round(stageMs / 2500));
    for (let k = 0; k < ticks; k++) {
      found = current(slot);
      if (!found) return finishIfDone(job);
      const before = STAGES.slice(0, i).reduce((s, x) => s + x[2], 0);
      found.task.progress = Math.round((before + share * (k / ticks)) * 100) / 100;
      taskEvent(job, found.v, found.task);
      await sleep(stageMs / ticks);
    }
    if (i === failAt) {
      found = current(slot);
      if (!found) return finishIfDone(job);
      Object.assign(found.task, { status: "failed", failure: FAILURES[Math.floor(random() * FAILURES.length)] });
      touch(found.v);
      taskEvent(job, found.v, found.task);
      return finishIfDone(job);
    }
  }
  const found = current(slot);
  if (!found) return finishIfDone(job);
  const { v, task } = found;
  const r = rng(task._seed);
  const content = buildTaskContent(TYPES.get(task.typeId), r);
  let image = null;
  if (content.withImage) {
    const assetId = `${v.id}-${task.number}-${task.taskRevision}`;
    if (random() < faults.imageMissingRate) missingAssets.add(assetId);
    image = { url: `/api/assets/${assetId}.svg`, alt: `Чертёж к заданию ${task.number}` };
  }
  Object.assign(task, {
    status: "ready", stage: null, stageTitle: null, progress: 1,
    content: { statement: content.statement, answer: content.answer, solution: content.solution, image },
    judgeNote: task.experimental
      ? "Задание создано ИИ без независимой математической проверки. Проверьте условие, ответ и решение."
      : "Условие однозначно, эталонный ответ подтверждён кодом.",
  });
  touch(v);
  taskEvent(job, v, task);
  finishIfDone(job);
}

function finishIfDone(job) {
  if (job.status !== "running") return;
  const v = variants.get(job.variantId);
  const mine = v ? Object.values(v.tasks).filter((t) => t.jobId === job.id) : [];
  if (mine.every((t) => ["ready", "failed", "canceled"].includes(t.status))) {
    job.status = job.canceled ? "canceled" : "done";
    emit(job, "job", { status: job.status, variantRevision: v?.revision });
  }
}

// ---------- SSE ----------

function stream(req, res, job, url) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache",
    Connection: "keep-alive", ...cors() });
  const last = Number(req.headers["last-event-id"] || url.searchParams.get("lastEventId") || 0);
  const write = (e) => res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  if (!last) {
    const v = variants.get(job.variantId);
    res.write(`event: snapshot\ndata: ${JSON.stringify({ jobId: job.id, status: job.status,
      lastEventId: job.events.length, variant: v ? publicVariant(v) : null })}\n\n`);
  } else {
    job.events.filter((e) => e.id > last).forEach(write);
  }
  const dropAfter = faults.dropAfterEvents || (random() < faults.dropRate ? 3 + Math.floor(random() * 6) : 0);
  if (faults.dropAfterEvents) faults.dropAfterEvents = 0;
  let sent = 0;
  const listener = (e) => {
    write(e);
    sent += 1;
    // Обрыв без закрывающего события — как у балансировщика или мобильной сети.
    if (dropAfter && sent >= dropAfter) res.destroy();
  };
  job.listeners.add(listener);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    job.listeners.delete(listener);
  });
}

// ---------- Проверка перед выдачей ----------

function revalidate(v) {
  // Как на проде: открытие варианта перепроверяет готовые задания. Первый раз — медленно.
  let delay = 0;
  for (const t of Object.values(v.tasks)) {
    if (t.status !== "ready" || t._checked === t.taskRevision) continue;
    t._checked = t.taskRevision;
    delay += 250 / Math.max(faults.speed / 3, 0.1);
    if (random() < faults.issueRate) {
      t.issues = [{ code: "revalidation_failed", message: "Задание не прошло повторную проверку — перегенерируйте его" }];
    }
  }
  return delay;
}

function blockers(v) {
  const list = [];
  const tasks = Object.values(v.tasks);
  if (!tasks.length) list.push({ code: "empty", message: "В варианте нет заданий" });
  for (const t of tasks) {
    if (["queued", "running"].includes(t.status)) list.push({ number: t.number, code: "in_progress", message: "Задание ещё генерируется" });
    if (["failed", "canceled"].includes(t.status)) list.push({ number: t.number, code: "not_ready", message: "Задание не сгенерировано" });
    if (t.issues.length) list.push({ number: t.number, code: "issues", message: t.issues[0].message });
    if (t.status === "ready" && t.experimental && !t.confirmation) {
      list.push({ number: t.number, code: "needs_confirmation", message: "Экспериментальное задание не подтверждено учителем" });
    }
  }
  return list;
}

// ---------- Маршруты ----------

const routes = [
  ["GET", /^\/api\/catalog$/, () => [200, CATALOG]],
  ["GET", /^\/api\/variants$/, () => [200, { variants: [...variants.values()].map((v) => {
    const { tasks, ...meta } = publicVariant(v);
    return { ...meta, taskCount: tasks.length };
  }) }]],
  ["POST", /^\/api\/variants$/, async (req) => {
    const body = await readJson(req);
    const now = new Date().toISOString();
    const v = { id: randomUUID(), title: String(body.title || "Новый вариант").slice(0, 120), revision: 1,
      status: "draft", createdAt: now, updatedAt: now, tasks: {} };
    variants.set(v.id, v);
    return [201, publicVariant(v)];
  }],
  ["GET", /^\/api\/variants\/([\w-]+)$/, async (req, [id]) => {
    const v = variantOr404(id);
    const delay = v.status === "draft" ? revalidate(v) : 0;
    if (delay) await sleep(delay);
    return [200, publicVariant(v)];
  }],
  ["PATCH", /^\/api\/variants\/([\w-]+)$/, async (req, [id]) => {
    const v = variantOr404(id);
    const body = await readJson(req);
    requireRevision(v, body.revision);
    if (typeof body.title === "string") v.title = body.title.slice(0, 120);
    touch(v);
    return [200, publicVariant(v)];
  }],
  ["POST", /^\/api\/variants\/([\w-]+)\/generate$/, async (req, [id]) => {
    const v = variantOr404(id);
    const body = await readJson(req);
    requireRevision(v, body.revision);
    const items = Array.isArray(body.tasks) ? body.tasks : [];
    if (!items.length) throw fail(400, "empty", "Не выбрано ни одного задания");
    if (new Set(items.map((i) => i.number)).size !== items.length) throw fail(400, "duplicate", "Номер задания повторяется");
    const job = startJob(v, items);
    return [202, { jobId: job.id, variant: publicVariant(v) }];
  }],
  ["DELETE", /^\/api\/variants\/([\w-]+)\/tasks\/(\d+)$/, async (req, [id, n]) => {
    const v = variantOr404(id);
    const body = await readJson(req);
    requireRevision(v, body.revision);
    if (!v.tasks[n]) throw fail(404, "not_found", "Задания нет в варианте");
    delete v.tasks[n];
    touch(v);
    return [200, publicVariant(v)];
  }],
  ["POST", /^\/api\/variants\/([\w-]+)\/tasks\/(\d+)\/confirm$/, async (req, [id, n]) => {
    const v = variantOr404(id);
    const body = await readJson(req);
    requireRevision(v, body.revision);
    const t = v.tasks[n];
    if (!t) throw fail(404, "not_found", "Задания нет в варианте");
    if (!t.experimental) throw fail(400, "not_experimental", "Подтверждение нужно только экспериментальным заданиям");
    if (t.status !== "ready" || t.taskRevision !== body.taskRevision) {
      throw fail(409, "task_changed", "Задание изменилось — проверьте новую версию", { current: publicVariant(v) });
    }
    t.confirmation = { confirmedAt: new Date().toISOString(), taskRevision: t.taskRevision };
    touch(v);
    return [200, publicVariant(v)];
  }],
  ["POST", /^\/api\/variants\/([\w-]+)\/publish$/, async (req, [id]) => {
    const v = variantOr404(id);
    const body = await readJson(req);
    requireRevision(v, body.revision);
    const list = blockers(v);
    if (list.length) throw fail(422, "blocked", "Вариант нельзя выдать", { blockers: list });
    v.status = "published";
    touch(v);
    return [200, publicVariant(v)];
  }],
  ["GET", /^\/api\/jobs\/([\w-]+)$/, (req, [id]) => {
    const job = jobs.get(id);
    if (!job) throw fail(404, "not_found", "Задача генерации не найдена");
    const v = variants.get(job.variantId);
    return [200, { jobId: job.id, status: job.status, lastEventId: job.events.length, variant: v ? publicVariant(v) : null }];
  }],
  ["POST", /^\/api\/jobs\/([\w-]+)\/cancel$/, (req, [id]) => {
    const job = jobs.get(id);
    if (!job) throw fail(404, "not_found", "Задача генерации не найдена");
    job.canceled = true;
    // Ожидающие отменяются сразу, уже идущие — на границе этапа: так ведёт себя настоящая очередь.
    const v = variants.get(job.variantId);
    for (const t of Object.values(v?.tasks || {})) {
      if (t.jobId === job.id && t.status === "queued") {
        t.status = "canceled";
        touch(v);
        taskEvent(job, v, t);
      }
    }
    finishIfDone(job);
    return [202, { jobId: job.id, status: job.status }];
  }],
  // ---- управление моком для e2e-тестов ----
  ["GET", /^\/api\/_mock\/faults$/, () => [200, faults]],
  ["POST", /^\/api\/_mock\/faults$/, async (req) => {
    faults = { ...faults, ...(await readJson(req)) };
    return [200, faults];
  }],
  ["POST", /^\/api\/_mock\/conflict\/([\w-]+)$/, (req, [id]) => {
    const v = variantOr404(id);
    v.title = `${v.title} (изменено в другой вкладке)`;
    touch(v);
    return [200, publicVariant(v)];
  }],
  ["POST", /^\/api\/_mock\/reset$/, () => {
    variants.clear(); jobs.clear(); queue.length = 0; missingAssets.clear();
    faults = { ...DEFAULT_FAULTS };
    random = rng(Number(process.env.MOCK_SEED || 42));
    return [200, { ok: true }];
  }],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") return send(res, 204);
  try {
    const asset = url.pathname.match(/^\/api\/assets\/([\w-]+)\.svg$/);
    if (req.method === "GET" && asset) {
      await sleep(200 + random() * 800);
      if (missingAssets.has(asset[1])) return send(res, 404, { code: "not_found", message: "Чертёж не найден" });
      res.writeHead(200, { "Content-Type": "image/svg+xml", ...cors() });
      return res.end(drawingSvg([...asset[1]].reduce((s, c) => s + c.charCodeAt(0), 0)));
    }
    const events = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/events$/);
    if (req.method === "GET" && events) {
      const job = jobs.get(events[1]);
      if (!job) return send(res, 404, { code: "not_found", message: "Задача генерации не найдена" });
      return stream(req, res, job, url);
    }
    for (const [method, pattern, handler] of routes) {
      const m = req.method === method && url.pathname.match(pattern);
      if (m) {
        const [status, body] = await handler(req, m.slice(1));
        return send(res, status, body);
      }
    }
    send(res, 404, { code: "not_found", message: "Нет такого маршрута" });
  } catch (err) {
    send(res, err.status || 500, { code: err.code || "internal", message: err.message, ...(err.extra || {}) });
  }
});

server.listen(PORT, () => {
  console.log(`Мок конструктора варианта: http://localhost:${PORT}/api  (speed=${faults.speed}, типов=${TYPES.size})`);
});
