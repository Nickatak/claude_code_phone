import fs from "fs";
import path from "path";

/**
 * Scan a base directory for project folders.
 * Used to populate the admin's project picker in the UI.
 * Projects with CLAUDE.md are sorted first (they're "real" projects).
 */
export function scanProjectDirs(baseDir: string) {
  const dirs: { path: string; name: string; hasClaudeMd: boolean }[] = [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const fullPath = path.join(baseDir, entry.name);
      const hasClaudeMd = fs.existsSync(path.join(fullPath, "CLAUDE.md")) ||
        fs.existsSync(path.join(fullPath, ".claude", "settings.json"));
      dirs.push({ path: fullPath, name: entry.name, hasClaudeMd });
    }
  } catch (err) {
    console.error("Error scanning project dirs:", err);
  }
  dirs.sort((a, b) => {
    if (a.hasClaudeMd !== b.hasClaudeMd) return a.hasClaudeMd ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return dirs;
}
