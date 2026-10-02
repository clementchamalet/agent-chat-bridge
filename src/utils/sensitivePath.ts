const PRIVATE_DIRECTORIES = new Set([".git", ".ssh", ".aws", ".gnupg", ".config", ".codex", ".claude"]);
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const PRIVATE_FILE =
  /^(?:\.env(?:\..*)?|\.npmrc|auth\.json|credentials(?:\..*)?|secrets?(?:\..*)?|id_[\w-]+|.*\.(?:pem|key|p12|pfx|db|sqlite3?)(?:-(?:wal|shm|journal))?)$/i;

export function isSensitivePath(filePath: string): boolean {
  const parts = filePath.replaceAll("\\", "/").split("/");
  return parts.some(
    (part, index) =>
      PRIVATE_DIRECTORIES.has(part.toLowerCase()) ||
      (index === parts.length - 1 && !ENV_TEMPLATES.has(part.toLowerCase()) && PRIVATE_FILE.test(part)),
  );
}
