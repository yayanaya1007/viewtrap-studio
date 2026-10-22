import { readFileSync, statSync } from "node:fs";

const entry = new URL("../dist/server/index.js", import.meta.url);
const source = readFileSync(entry, "utf8");
if (!source.includes("export default") || !source.includes("/api/search") || !source.includes("/api/analyze")) {
  throw new Error("Worker artifact is missing required routes.");
}
if (statSync(entry).size > 2_000_000) throw new Error("Worker artifact is unexpectedly large.");
const module = await import(entry.href);
if (typeof module.default?.fetch !== "function") throw new Error("Worker artifact has no fetch handler.");
console.log("Worker artifact is ready.");
