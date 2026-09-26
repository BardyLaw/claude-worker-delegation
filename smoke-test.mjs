import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
fs.writeFileSync("sample.txt", Array.from({length: 300}, (_, i) => `line ${i}: status=${i % 50 === 7 ? "ERROR disk full" : "ok"}`).join("\n"));
const c = new Client({ name: "smoke", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: ["server.js"], env: process.env }));
console.log((await c.listTools()).tools.map(t => t.name).join(", "));
const show = r => console.log(r.isError ? "ERROR: " : "", r.content[0].text, "\n");
show(await c.callTool({ name: "delegate", arguments: { task: "Reply with exactly: OK", tier: "fast", max_tokens: 20 } }));
show(await c.callTool({ name: "delegate", arguments: { task: "List every line number with an ERROR, comma-separated.", files: ["sample.txt"] } }));
show(await c.callTool({ name: "delegate_batch", arguments: { jobs: [
  { task: "Write a one-line Python function that reverses a string.", tier: "code" },
  { task: "Is 2^31-1 prime? One word.", tier: "reason", max_tokens: 2000 },
  { task: "Say hi in 3 words.", tier: "long" } ] } }));
show(await c.callTool({ name: "delegate", arguments: { task: "x", files: ["C:/Windows/win.ini"] } }));
show(await c.callTool({ name: "worker_stats", arguments: {} }));
await c.close();
