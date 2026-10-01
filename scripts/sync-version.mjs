// Il server MCP dichiara la sua versione a runtime con un literal in src/server.ts.
// `npm version` non tocca i sorgenti, quindi senza questo passo il bundle si
// presenta con una versione diversa da quella del suo manifest.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const file = "src/server.ts";
const before = readFileSync(file, "utf8");
const after = before
  .replace(/(new McpServer\(\s*\{ name: "[a-z]+", version: )"[^"]*"/, `$1"${version}"`)
  // Stessa versione nello User-Agent con cui l'MCP firma le chiamate all'API:
  // /admin/mcp la legge per sapere chi gira ancora su una build vecchia.
  .replace(/(const MCP_UA_BASE = "[a-z]+-mcp\/)[^"]*"/, `$1${version}"`);
if (before === after && !after.includes(`version: "${version}"`)) {
  console.error(`sync-version: literal non trovato in ${file}`);
  process.exit(1);
}
writeFileSync(file, after);
console.log(`sync-version: ${file} -> ${version}`);
