// workers-mcp: lets the Claude "architect" delegate bulk work to cheap OpenRouter models.
// The architect passes file paths; this server reads them, so big content never enters Claude's context.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(HERE, "models.json"), "utf8"));
const LOG = path.join(HERE, "usage.jsonl");
const KEY = process.env.OPENROUTER_API_KEY;

// Files may only be read/written under the session cwd or extra roots (WORKERS_ALLOWED_ROOTS, ';'-separated).
const ROOTS = [process.cwd(), ...(process.env.WORKERS_ALLOWED_ROOTS || "").split(";").filter(Boolean)]
  .map((r) => path.resolve(r).toLowerCase());

function safePath(p) {
  const abs = path.resolve(process.cwd(), p);
  const low = abs.toLowerCase();
  if (!ROOTS.some((r) => low === r || low.startsWith(r + path.sep))) {
    throw new Error(`path outside allowed roots: ${abs} (allowed: ${ROOTS.join(", ")})`);
  }
  return abs;
}

const SYSTEM = `You are a worker model taking orders from a senior architect model.
Rules:
- Do exactly the task. No preamble, no closing summary, no restating the task.
- Only rely on file contents actually provided below. Never invent code or file contents you were not shown; say "NOT PROVIDED: <what>" instead.
- For code changes, output a unified diff (--- a/path +++ b/path) unless asked for complete files.
- For summaries, be dense: bullet points, concrete names/lines/numbers.
- If the task is ambiguous or impossible, say so in one line and stop.`;

function spentToday() {
  if (!fs.existsSync(LOG)) return 0;
  const day = new Date().toISOString().slice(0, 10);
  return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.ts.startsWith(day))
    .reduce((s, r) => s + (r.cost || 0), 0);
}

function buildPrompt(task, files = []) {
  let body = `TASK:\n${task}\n`;
  for (const f of files) {
    const abs = safePath(f);
    const buf = fs.readFileSync(abs);
    const text = buf.subarray(0, CFG.max_file_bytes).toString("utf8");
    const cut = buf.length > CFG.max_file_bytes ? `\n[...truncated, ${buf.length} bytes total]` : "";
    body += `\n===== FILE: ${f} =====\n${text}${cut}\n===== END FILE =====\n`;
  }
  return body;
}

async function runJob({ task, tier = "fast", files, write_to, max_tokens }) {
  if (!KEY) throw new Error("OPENROUTER_API_KEY is not set in the environment");
  const t = CFG.tiers[tier];
  if (!t) throw new Error(`unknown tier "${tier}" (have: ${Object.keys(CFG.tiers).join(", ")})`);
  const spent = spentToday();
  if (spent >= CFG.daily_budget_usd) {
    throw new Error(`daily worker budget $${CFG.daily_budget_usd} reached ($${spent.toFixed(4)} spent) — edit models.json to raise it`);
  }
  const outPath = write_to ? safePath(write_to) : null;
  const started = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "X-Title": "claude-workers-mcp" },
    body: JSON.stringify({
      model: t.model,
      max_tokens: max_tokens || CFG.default_max_tokens,
      usage: { include: true },
      ...(CFG.provider && { provider: CFG.provider }),
      ...t.params, // per-tier extras, e.g. disabling reasoning on the fast tier
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: buildPrompt(task, files) }],
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(data.error || data).slice(0, 500)}`);
  const text = data.choices?.[0]?.message?.content ?? "";
  const u = data.usage || {};
  const rec = {
    ts: new Date().toISOString(), tier, model: data.model || t.model,
    in: u.prompt_tokens || 0, out: u.completion_tokens || 0, cost: u.cost || 0,
    ms: Date.now() - started, task: task.slice(0, 120),
  };
  fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
  const meta = `[${tier}/${rec.model} in=${rec.in} out=${rec.out} $${rec.cost.toFixed(5)} ${rec.ms}ms]`;

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text);
    const lines = text.split("\n");
    return `${meta}\nwrote ${lines.length} lines to ${outPath}\n--- first 20 lines ---\n${lines.slice(0, 20).join("\n")}`;
  }
  const capped = text.length > CFG.max_return_chars
    ? text.slice(0, CFG.max_return_chars) + `\n[...truncated ${text.length - CFG.max_return_chars} chars; use write_to for full output]`
    : text;
  return `${meta}\n${capped}`;
}

const jobShape = {
  task: z.string().describe("Precise instructions for the worker. Include acceptance criteria and output format."),
  tier: z.enum(Object.keys(CFG.tiers)).default("fast").describe(
    Object.entries(CFG.tiers).map(([k, v]) => `${k}: ${v.use}`).join("; ")),
  files: z.array(z.string()).optional().describe("Paths the server loads into the worker prompt — do NOT read them yourself first."),
  write_to: z.string().optional().describe("Save full output here and return only a 20-line preview. Use for anything > ~50 lines."),
  max_tokens: z.number().int().positive().optional(),
};

const server = new McpServer({ name: "workers", version: "1.0.0" });
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e.message || e) }] });

server.registerTool("delegate", {
  description: "Hand a self-contained subtask to a cheap worker model (OpenRouter). Use for bulk reading/summarizing, boilerplate, tests, mechanical edits as diffs, first drafts, or a second opinion. Review the result before acting on it.",
  inputSchema: jobShape,
}, async (args) => { try { return ok(await runJob(args)); } catch (e) { return fail(e); } });

server.registerTool("delegate_batch", {
  description: "Run several independent worker jobs in parallel. Returns one result block per job.",
  inputSchema: { jobs: z.array(z.object(jobShape)).min(1).max(20) },
}, async ({ jobs }) => {
  const results = new Array(jobs.length);
  let next = 0;
  const lane = async () => {
    while (next < jobs.length) {
      const i = next++;
      try { results[i] = `## job ${i + 1}\n` + await runJob(jobs[i]); }
      catch (e) { results[i] = `## job ${i + 1} FAILED\n${e.message || e}`; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CFG.concurrency, jobs.length) }, lane));
  return ok(results.join("\n\n"));
});

server.registerTool("worker_stats", {
  description: "Worker token/cost totals: today and all-time, by tier.",
  inputSchema: {},
}, async () => {
  if (!fs.existsSync(LOG)) return ok("no worker calls yet");
  const rows = fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const day = new Date().toISOString().slice(0, 10);
  const agg = (rs) => rs.reduce((a, r) => ({ n: a.n + 1, in: a.in + r.in, out: a.out + r.out, cost: a.cost + r.cost }),
    { n: 0, in: 0, out: 0, cost: 0 });
  const fmt = (a) => `${a.n} calls, ${a.in} in / ${a.out} out tokens, $${a.cost.toFixed(4)}`;
  const tiers = Object.keys(CFG.tiers).map((t) => `  ${t}: ${fmt(agg(rows.filter((r) => r.tier === t)))}`).join("\n");
  return ok(`today: ${fmt(agg(rows.filter((r) => r.ts.startsWith(day))))} (budget $${CFG.daily_budget_usd})\nall-time: ${fmt(agg(rows))}\n${tiers}`);
});

await server.connect(new StdioServerTransport());
