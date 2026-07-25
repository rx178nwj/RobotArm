import { readFile } from "node:fs/promises";

const renderer = await readFile("dist/renderer/renderer.js", "utf8");
const forbiddenCommonJs = [
  'Object.defineProperty(exports, "__esModule"',
  "require("
];

for (const token of forbiddenCommonJs) {
  if (renderer.includes(token)) {
    throw new Error(`Renderer bundle contains CommonJS runtime code: ${token}`);
  }
}
