import { loadConfig } from "../config/loader.js";
import { validateCrossReferences } from "../config/validate.js";

export function runValidate(configPath: string): number {
  const loaded = loadConfig(configPath);
  const result = validateCrossReferences(loaded.config);

  for (const issue of result.issues) {
    const tag = issue.level === "error" ? "ERROR" : "WARN ";
    console.log(`${tag} ${issue.path}: ${issue.message}`);
  }

  if (result.ok) {
    console.log(`Config valid: ${loaded.path}`);
    return 0;
  }
  console.error(
    `Config invalid: ${result.issues.filter((i) => i.level === "error").length} error(s)`,
  );
  return 1;
}
