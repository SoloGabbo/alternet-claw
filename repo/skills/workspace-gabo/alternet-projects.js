#!/usr/bin/env node
// Alternet Projects CLI — ejecutado por Gabo via exec()
// Uso: node alternet-projects.js <comando> [params...]
// Node.js 18+ (fetch nativo)

const API_BASE = "http://172.17.0.1:4110/api";
const DEFAULT_CONTEXT = "alternet"; // contexto por defecto de Gabo

// ─── Helpers ───────────────────────────────────────────────────────────────

function exitError(msg) {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(1);
}

function exitOk(msg) {
  process.stdout.write(msg + "\n");
}

async function apiFetch(path, options = {}) {
  // Agregar context query param si no está presente
  const sep = path.includes("?") ? "&" : "?";
  const pathWithContext = path.includes("context=") ? path : `${path}${sep}context=${options.context || DEFAULT_CONTEXT}`;
  const url = `${API_BASE}${pathWithContext}`;
  try {
    const res = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

// Parsea argumentos simples: [--key value] [--key "quoted"]
function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--" || a === "-") {
      // skip bare dashes
      continue;
    }
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[a.slice(2)] = argv[i + 1];
      i++;
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

// ─── Comandos ──────────────────────────────────────────────────────────────

/**
 * listar-proyectos [--owner gabo]
 */
async function cmdListarProyectos(flags) {
  const res = await apiFetch("/projects");
  if (!res.ok) return exitError(`Error de conexión: ${res.error}`);

  let projects = res.data.data || res.data || [];
  if (flags.owner) {
    projects = projects.filter(
      (p) => (p.owner || "").toLowerCase() === flags.owner.toLowerCase()
    );
  }

  if (projects.length === 0) {
    exitOk(flags.owner ? `📭 No hay proyectos para owner "${flags.owner}"` : "📭 No hay proyectos");
    return;
  }

  // Fetch tasks count per project in parallel
  const withTasks = await Promise.all(
    projects.map(async (p) => {
      const tres = await apiFetch(`/tasks?project_id=${p.id}`);
      const tasks = tres.ok ? (tres.data.data || tres.data || []) : [];
      const completed = tasks.filter((t) => t.status === "completed").length;
      return { ...p, taskTotal: tasks.length, taskCompleted: completed };
    })
  );

  const lines = withTasks.map((p) => {
    const statusEmoji =
      p.status === "completed" ? "✅" : p.status === "blocked" ? "🔴" : p.status === "paused" ? "⏸️" : "🗂️";
    const taskInfo =
      p.taskTotal > 0
        ? `Tareas: ${p.taskCompleted} completadas / ${p.taskTotal} total`
        : "Sin tareas";
    return `[P${String(p.id).padStart(2, "0")}] ${statusEmoji} ${p.name}
      Estado: ${p.status} | Owner: ${p.owner || "sin asignar"} | Prioridad: ${p.priority || "normal"}
      ${taskInfo}`;
  });

  exitOk(contextHeader + lines.join("\n\n"));
}

/**
 * listar-tareas <project_id> [--status backlog]
 */
async function cmdListarTareas(args, flags) {
  const projectId = args[0];
  if (!projectId) return exitError("Uso: listar-tareas <project_id> [--status backlog]");

  // Fetch contexto del proyecto
  const ctxRes = await apiFetch(`/projects/${projectId}/context`);
  const projectContext = (ctxRes.ok && ctxRes.data.context) ? ctxRes.data.context.slice(0, 200) : null;
  const projectName = (ctxRes.ok && ctxRes.data.name) ? ctxRes.data.name : projectId;

  const res = await apiFetch(`/tasks?project_id=${projectId}`);
  if (!res.ok) return exitError(`Error de conexión: ${res.error}`);

  let tasks = res.data.data || res.data || [];
  if (flags.status) {
    tasks = tasks.filter((t) => t.status === flags.status);
  }

  if (tasks.length === 0) {
    exitOk(flags.status ? `📭 No hay tareas con status "${flags.status}"` : "📭 No hay tareas para este proyecto");
    return;
  }

  // Fetch subtasks per task
  const withSubtasks = await Promise.all(
    tasks.map(async (t) => {
      const sres = await apiFetch(`/tasks/${t.id}/subtasks`);
      const subs = sres.ok ? (sres.data.data || sres.data || []) : [];
      const completed = subs.filter((s) => s.completed).length;
      return { ...t, subtasks: subs, subCompleted: completed, subTotal: subs.length };
    })
  );

  const contextHeader = projectContext
    ? `📋 ${projectName}\nContexto: ${projectContext}${projectContext.length >= 200 ? "..." : ""}\n\n`
    : `📋 ${projectName}\n\n`;

  const lines = withSubtasks.map((t) => {
    const statusLabel = t.status || "backlog";
    const subInfo =
      t.subTotal > 0 ? `Subtareas: ${t.subCompleted}/${t.subTotal} completadas` : "";
    const subLines =
      t.subtasks.length > 0
        ? t.subtasks
            .map((s) => {
              const icon = s.completed ? "✅" : "⬜";
              return `    ${icon} ${s.title || s.description || "Sin título"}`;
            })
            .join("\n")
        : "";

    return `[T${String(t.id).padStart(2, "0")}] ${t.title || t.name || "Sin título"} [${t.priority || "normal"} · ${statusLabel}]
      Agente: ${t.assigned_agent || "sin asignar"} | ${subInfo}
${subLines}`.trimEnd();
  });

  exitOk(lines.join("\n\n"));
}

/**
 * actualizar-tarea <task_id> <status> [--agente nombre]
 */
async function cmdActualizarTarea(args, flags) {
  const taskId = args[0];
  const status = args[1];
  const validStatuses = ["backlog", "in-progress", "completed", "blocked"];

  if (!taskId || !status)
    return exitError("Uso: actualizar-tarea <task_id> <status>\n  Status válidos: " + validStatuses.join(", "));
  if (!validStatuses.includes(status))
    return exitError(`Status inválido: "${status}". Válidos: ${validStatuses.join(", ")}`);

  const body = { status };
  if (flags.agente) body.assigned_agent = flags.agente;

  const res = await apiFetch(`/tasks/${taskId}`, { method: "PATCH", body });
  if (!res.ok) return exitError(`API error ${res.status}: ${res.error}`);

  exitOk(`✅ Tarea actualizada: #${taskId} → ${status}${flags.agente ? ` (agente: ${flags.agente})` : ""}`);
}

/**
 * toggle-subtarea <task_id> <subtask_id> <true|false>
 */
async function cmdToggleSubtarea(args) {
  const taskId = args[0];
  const subtaskId = args[1];
  const completedStr = args[2];
  const completed = completedStr === "true";

  if (!taskId || !subtaskId || (completedStr !== "true" && completedStr !== "false"))
    return exitError("Uso: toggle-subtarea <task_id> <subtask_id> <true|false>");

  const res = await apiFetch(`/subtasks/${subtaskId}`, {
    method: "PATCH",
    body: { completed },
  });
  if (!res.ok) return exitError(`API error ${res.status}: ${res.error}`);

  exitOk(`✅ Subtarea #${subtaskId} marcada como ${completed ? "completada" : "pendiente"}`);
}

/**
 * ver-cola
 */
async function cmdVerCola() {
  const res = await apiFetch("/job-queue");
  if (!res.ok) return exitError(`Error de conexión: ${res.error}`);

  const jobs = res.data.data || res.data || [];
  if (jobs.length === 0) {
    exitOk("🟢 Cola vacía — sin jobs pendientes");
    return;
  }

  const lines = jobs.map((j, i) => {
    const statusEmoji =
      j.status === "working" ? "🟢" : j.status === "done" ? "✅" : j.status === "paused" ? "⏸️" : j.status === "cancelled" ? "🔴" : "⏳";
    const statusLabel =
      j.status === "working"
        ? `WORKING (desde hace ${j.started_at ? Math.round((Date.now() - new Date(j.started_at).getTime()) / 60000) : "?"} min)`
        : j.status === "done"
        ? "DONE"
        : j.status === "paused"
        ? `PAUSED — ${j.pause_reason || "sin razón"}`
        : j.status === "cancelled"
        ? "CANCELLED"
        : `PENDING #${i + 1}`;
    const priority = j.priority ? `(prioridad ${j.priority})` : "";
    return `${statusEmoji} ${statusLabel}: ${j.project_name || j.name || `Job #${j.id}`} ${priority}`;
  });

  exitOk(lines.join("\n"));
}

/**
 * reportar-job <job_id> <done|paused> [--razon "texto"]
 */
async function cmdReportarJob(args, flags) {
  const jobId = args[0];
  const action = args[1];

  if (!jobId || !action)
    return exitError("Uso: reportar-job <job_id> <done|paused> [--razon \"texto\"]");
  if (action === "paused" && !flags.razon)
    return exitError("Cuando el status es 'paused', debes incluir --razon \"descripción del bloqueo\"");

  const statusMap = { done: "done", paused: "paused_awaiting_approval" };
  const status = statusMap[action];
  if (!status) return exitError(`Acción inválida: "${action}". Usa done o paused.`);

  const body = { status };
  if (flags.razon) body.pause_reason = flags.razon;

  const res = await apiFetch(`/job-queue/${jobId}`, { method: "PATCH", body });
  if (!res.ok) return exitError(`API error ${res.status}: ${res.error}`);

  if (action === "done") {
    exitOk(`✅ Job #${jobId} marcado como done — el watchdog tomará el siguiente`);
  } else {
    exitOk(`⏸️ Job #${jobId} pausado: ${flags.razon}\n📬 Debes notificar a Gabriel (Jefe) por Telegram.`);
  }
}

/**
 * crear-checkpoint <task_id> "<descripcion>"
 */
async function cmdCrearCheckpoint(args) {
  const taskId = args[0];
  const descripcion = args.slice(1).join(" ");

  if (!taskId || !descripcion)
    return exitError('Uso: crear-checkpoint <task_id> "<descripcion>"');

  const res = await apiFetch(`/tasks/${taskId}/checkpoints`, {
    method: "POST",
    body: { description: descripcion },
  });

  if (!res.ok && res.status === 404) {
    // Fallback local
    const fs = await import("fs");
    const path = await import("path");
    const logPath = "/tmp/checkpoints.log";
    const line = `[${new Date().toISOString()}] TASK:${taskId} | ${descripcion}\n`;
    try {
      fs.appendFileSync(logPath, line);
      exitOk(`⚠️ Checkpoint guardado localmente (endpoint pendiente)\n📄 ${logPath}`);
    } catch (err) {
      exitError(`No se pudo guardar checkpoint local: ${err.message}`);
    }
    return;
  }

  if (!res.ok) return exitError(`API error ${res.status}: ${res.error}`);
  exitOk(`✅ Checkpoint registrado para tarea #${taskId}`);
}

// ─── Help ──────────────────────────────────────────────────────────────────

function printHelp() {
  exitOk(`
🤖 Alternet Projects CLI — Skill de Gabo

Uso: node alternet-projects.js <comando> [params]

Comandos:
  listar-proyectos [--owner gabo]
  listar-tareas <project_id> [--status backlog]
  actualizar-tarea <task_id> <status> [--agente nombre]
  toggle-subtarea <task_id> <subtask_id> <true|false>
  ver-cola
  reportar-job <job_id> <done|paused> [--razon "texto"]
  crear-checkpoint <task_id> "<descripcion>"

Status válidos: backlog, in-progress, completed, blocked
`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

/**
 * ver-contexto <project_id>
 */
async function cmdVerContexto(args) {
  const projectId = args[0];
  if (!projectId) return exitError("Uso: ver-contexto <project_id>");

  const res = await apiFetch(`/projects/${projectId}/context`);
  if (!res.ok) return exitError(`Error de conexión: ${res.error}`);

  const { name, context } = res.data;
  if (!context || context.trim() === "") {
    exitOk(`📋 Proyecto: ${name}\n\n⚠️  Sin contexto técnico configurado.\nEdita el proyecto en el dashboard para agregar contexto.`);
    return;
  }
  exitOk(`📋 Proyecto: ${name}\n\n=== CONTEXTO TÉCNICO ===\n${context}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "--help" || cmd === "-h") return printHelp();

  const { args, flags } = parseArgs(rest);

  const commands = {
    "listar-proyectos": () => cmdListarProyectos(flags),
    "listar-tareas": () => cmdListarTareas(args, flags),
    "actualizar-tarea": () => cmdActualizarTarea(args, flags),
    "toggle-subtarea": () => cmdToggleSubtarea(args),
    "ver-cola": () => cmdVerCola(),
    "reportar-job": () => cmdReportarJob(args, flags),
    "crear-checkpoint": () => cmdCrearCheckpoint(args),
    "ver-contexto": () => cmdVerContexto(args),
  };

  const fn = commands[cmd];
  if (!fn) {
    exitError(`Comando desconocido: "${cmd}"\n\nUsa --help para ver los comandos disponibles.`);
  }

  await fn();
}

main().catch((err) => exitError(`Error inesperado: ${err.message}`));
