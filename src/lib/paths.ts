import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root, whether running from src/ (tsx) or dist/src/ (compiled). */
function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "migrations"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export const projectRoot = findRoot();
