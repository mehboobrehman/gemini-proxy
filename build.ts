import { HTML } from "./src/ui.ts";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const distDir = join(process.cwd(), "dist");
mkdirSync(distDir, { recursive: true });

const indexPath = join(distDir, "index.html");
writeFileSync(indexPath, HTML, "utf-8");

console.log(`Successfully built web assets into ${indexPath}`);
