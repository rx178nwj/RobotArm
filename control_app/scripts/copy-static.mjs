import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/renderer", { recursive: true });
await Promise.all([
  cp("src/renderer/index.html", "dist/renderer/index.html"),
  cp("src/renderer/styles.css", "dist/renderer/styles.css")
]);
