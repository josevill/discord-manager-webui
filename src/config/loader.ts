import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type ServerConfig, ServerConfigSchema } from "./schema.js";

export interface LoadedConfig {
  config: ServerConfig;
  path: string;
  baseDir: string;
  raw: string;
}

export function loadConfig(filePath: string): LoadedConfig {
  const absolute = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const raw = readFileSync(absolute, "utf8");
  let data: unknown;
  if (absolute.endsWith(".json")) {
    data = JSON.parse(raw);
  } else {
    data = parseYaml(raw);
  }
  const parsed = ServerConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config schema in ${absolute}:\n${issues}`);
  }
  return {
    config: parsed.data,
    path: absolute,
    baseDir: dirname(absolute),
    raw,
  };
}

/** Persist a ServerConfig to YAML or JSON matching the target path extension. */
export function saveConfig(filePath: string, config: ServerConfig): LoadedConfig {
  const absolute = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const parsed = ServerConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config schema:\n${issues}`);
  }
  const raw = absolute.endsWith(".json")
    ? `${JSON.stringify(parsed.data, null, 2)}\n`
    : stringifyYaml(parsed.data, { lineWidth: 0 });
  writeFileSync(absolute, raw, "utf8");
  return {
    config: parsed.data,
    path: absolute,
    baseDir: dirname(absolute),
    raw,
  };
}

/** Resolve a config-relative asset path to an absolute path. */
export function resolveAssetPath(baseDir: string, asset: string): string {
  if (asset.startsWith("data:") || asset.startsWith("http://") || asset.startsWith("https://")) {
    return asset;
  }
  return isAbsolute(asset) ? asset : resolve(baseDir, asset);
}
