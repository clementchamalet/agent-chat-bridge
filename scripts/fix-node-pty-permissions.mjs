// Ensure node-pty's packaged spawn helpers are executable after installation.
import fs from "node:fs";
import path from "node:path";

const prebuildsDir = path.join(process.cwd(), "node_modules", "node-pty", "prebuilds");

if (!fs.existsSync(prebuildsDir)) {
  process.exit(0);
}

for (const platform of fs.readdirSync(prebuildsDir)) {
  const helper = path.join(prebuildsDir, platform, "spawn-helper");
  if (fs.existsSync(helper)) {
    fs.chmodSync(helper, 0o755);
    console.log(`[fix-node-pty-permissions] chmod +x ${path.relative(process.cwd(), helper)}`);
  }
}
