import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const page = readFileSync("index.html", "utf8");
const client = readFileSync("client.js", "utf8");
const template = readFileSync("worker/index.js", "utf8");
if (!template.includes("__PAGE_HTML__") || !template.includes("__CLIENT_JS__")) {
  throw new Error("Worker source is missing its page or client placeholders.");
}
// Use callback replacements so dollar sequences in the page/client source are
// copied literally. String.replace's replacement-string syntax interprets `$$`
// as a single `$`, which silently corrupts the browser's `$$` query helper.
const built = template
  .replace("__PAGE_HTML__", () => JSON.stringify(page))
  .replace("__CLIENT_JS__", () => JSON.stringify(client));
const output = path.resolve("dist/server/index.js");
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, built, "utf8");
mkdirSync(path.resolve("dist/.openai"), { recursive: true });
copyFileSync(path.resolve(".openai/hosting.json"), path.resolve("dist/.openai/hosting.json"));
console.log("Built Worker with embedded HTML and browser client.");
