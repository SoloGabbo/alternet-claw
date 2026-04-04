#!/usr/bin/env node
// Morning Briefing Generator — ejecutado por Gabo via exec()
// Uso: node morning-briefing.js [--dry-run]
// Node.js 18+ (fetch nativo)

const API_BASE = process.env.API_BASE || 'http://187.77.157.31:4110/api';
const ACP_RELAY = process.env.ACP_RELAY || 'http://172.17.0.1:7070/relay';
const GABO_CHAT_ID = '8400833530';
const JARVIS_BASE = process.env.JARVIS_BASE || 'http://100.108.144.35:3210/api';

function exitError(msg) {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(1);
}

function exitOk(msg) {
  process.stdout.write(msg + '\n');
}

async function apiFetch(path) {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

async function sendACP(message) {
  try {
    const res = await fetch(ACP_RELAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'gabo', message, chatId: GABO_CHAT_ID }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (err) {
    return false;
  }
}

async function fetchJarvisWallet() {
  try {
    const now = new Date();
    const mes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const [resumenRes, presupuestoRes] = await Promise.all([
      fetch(`${JARVIS_BASE}/resumen?periodo=mes`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${JARVIS_BASE}/presupuesto/comparacion?mes=${mes}`, { signal: AbortSignal.timeout(8000) }),
    ]);

    const resumen = resumenRes.ok ? await resumenRes.json() : null;
    const presupuesto = presupuestoRes.ok ? await presupuestoRes.json() : null;

    return { resumen, presupuesto, mes };
  } catch (err) {
    return { error: err.message };
  }
}

function formatWalletSection(wallet) {
  if (wallet.error) {
    return `💼 JARVIS WALLET\n⚠️ No disponible (${wallet.error})\n`;
  }

  let text = `💼 JARVIS WALLET\n`;

  // Balances por cuenta
  const { resumen, presupuesto } = wallet;
  if (resumen?.balances?.length > 0) {
    const cuentas = resumen.balances.filter(b => b.saldo !== 0 || b.tipo !== 'crypto');
    const formatSaldo = (b) => {
      if (b.moneda === 'BTC') return `${b.saldo} BTC`;
      return `$${Number(b.saldo).toLocaleString('es-MX', { minimumFractionDigits: 0 })}`;
    };
    text += cuentas.map(b => `${b.emoji} ${b.cuenta}: ${formatSaldo(b)}`).join(' | ');
    text += '\n';
  }

  // Resumen del mes
  if (resumen) {
    const ing = Number(resumen.ingresos?.total || 0);
    const gas = Number(resumen.total?.total || 0);
    const fmt = (n) => `$${n.toLocaleString('es-MX', { minimumFractionDigits: 0 })}`;
    text += `📊 Mes: Ingresos ${fmt(ing)} | Gastos ${fmt(gas)}`;
    if (ing > 0 || gas > 0) text += ` | Balance ${fmt(ing - gas)}`;
    text += '\n';
  }

  // Presupuesto
  if (presupuesto?.resumen) {
    const p = presupuesto.resumen;
    const pct = p.porcentaje_general || 0;
    const excedidas = p.num_excedidas || 0;
    const advertencias = p.num_advertencias || 0;
    const fmt = (n) => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0 })}`;
    const icon = excedidas > 0 ? '🔴' : advertencias > 0 ? '🟡' : '🟢';
    text += `${icon} Presupuesto ${wallet.mes}: ${fmt(p.total_gastado)} / ${fmt(p.total_presupuestado)} (${pct}%)`;
    if (excedidas > 0) text += ` — ⚠️ ${excedidas} categoría${excedidas > 1 ? 's' : ''} excedida${excedidas > 1 ? 's' : ''}`;
    text += '\n';

    // Categorías con gasto
    const conGasto = presupuesto.categorias?.filter(c => c.gastado > 0) || [];
    if (conGasto.length > 0) {
      text += conGasto
        .map(c => `  ${c.categoria_emoji} ${c.categoria_nombre}: ${fmt(c.gastado)} / ${fmt(c.limite)} (${c.porcentaje}%)`)
        .join('\n');
      text += '\n';
    }
  }

  return text;
}

async function generateBriefing() {
  const [res, wallet] = await Promise.all([
    apiFetch('/briefing?context=alternet'),
    fetchJarvisWallet(),
  ]);
  if (!res.ok) return exitError(`API error ${res.status}: ${res.error}`);

  const b = res.data;
  const now = new Date();
  const dateStr = now.toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  let text = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🌅 MORNING BRIEFING — ${dateStr}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  text += `🤖 PROYECTOS ACTIVOS DE GABO\n`;
  text += (b.projects_working?.length > 0
    ? b.projects_working.map(p => `• ${p.name} (${p.status})`).join('\n')
    : '• Sin proyectos activos');
  text += '\n\n';

  text += `⏳ COLA DE TRABAJO\n`;
  text += (b.queue?.length > 0
    ? b.queue.map(j => `• ${j.status === 'working' ? '🟢 WORKING' : '⏳ PENDING'}: ${j.project_name} (prioridad ${j.priority})`).join('\n')
    : '• Cola vacía');
  text += '\n\n';

  text += `✅ COMPLETADO HOY (últimas 24h)\n`;
  text += (b.tasks_completed_24h?.length > 0
    ? b.tasks_completed_24h.map(t => `• ${t.title} — ${t.assigned_agent || 'sin agente'} (${t.project_name || 'sin proyecto'})`).join('\n')
    : '• Nada completado');
  text += '\n\n';

  text += `🔄 EN PROGRESO AHORA\n`;
  text += (b.tasks_in_progress?.length > 0
    ? b.tasks_in_progress.map(t => `• ${t.title} — ${t.assigned_agent || 'sin agente'} (${t.project_name || 'sin proyecto'})`).join('\n')
    : '• Nada en progreso');
  text += '\n\n';

  text += `🔗 TAREAS BLOQUEADAS\n`;
  text += (b.tasks_blocked?.length > 0
    ? b.tasks_blocked.map(t => `• ${t.title} (esperando: ${t.depends_on_title})`).join('\n')
    : '• Sin bloqueos');
  text += '\n\n';

  text += `🤖 AGENTES TRABAJANDO\n`;
  const agents = Object.entries(b.agents_with_tasks || {});
  text += (agents.length > 0
    ? agents.map(([a, c]) => `${a}: ${c} tarea${c > 1 ? 's' : ''}`).join(' | ')
    : '• Sin tareas asignadas');
  text += '\n\n';

  text += formatWalletSection(wallet);

  return text;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const briefing = await generateBriefing();

  if (dryRun) {
    exitOk(briefing);
    exitOk('\n📋 Morning Briefing generado (dry-run)');
    return;
  }

  const sent = await sendACP(briefing);
  if (sent) {
    exitOk('✅ Morning Briefing enviado a Gabo');
  } else {
    // Fallback: print briefing and warn
    exitOk(briefing);
    exitOk('\n⚠️ ACP relay no disponible — briefing impreso en consola');
  }
}

main().catch(e => exitError(`Error inesperado: ${e.message}`));
