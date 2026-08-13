import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCodexModelCatalogIds } from "@ccr/core/agents/codex/model-catalog";
import type { AppConfig, ProfileConfig } from "@ccr/core/contracts/app";
import { findModelCatalogEntry, modelCatalogMaxInputTokens } from "@ccr/core/gateway/model-catalog";
import { modelRegistryForConfig } from "@ccr/core/routing/model-registry";

export type PiProfileConfigWriteResult = {
  changed: boolean;
  file: string;
  model: string;
  profileHome: string;
  providerId: string;
  sessionDir: string;
};

const privateDirMode = 0o700;
const privateFileMode = 0o600;

export function resolvePiAgentDir(configDir: string, profile: ProfileConfig): string {
  if (profile.scope === "ccr" || profile.scope === "custom") {
    const slug = sanitizePathSegment(profile.id || profile.name || "pi") || "pi";
    const baseDir = path.join(configDir, "profiles", slug);
    return path.join(profile.scope === "custom" ? path.join(baseDir, "custom") : baseDir, "pi");
  }

  const configured = profile.configFile?.trim();
  return configured ? resolveUserPath(configured) : path.join(homeDir(), ".pi", "agent");
}

export function resolvePiSessionDir(configDir: string, profile: ProfileConfig): string {
  return path.join(resolvePiAgentDir(configDir, profile), "sessions");
}

export function piWrapperFilename(profile: ProfileConfig): string {
  const slug = sanitizePathSegment(profile.id || profile.name || profile.agent) || "pi";
  return process.platform === "win32"
    ? `ccr-pi-wrapper-${slug}.cmd`
    : `ccr-pi-wrapper-${slug}`;
}

export function writePiGatewayConfig(
  configDir: string,
  config: AppConfig,
  profile: ProfileConfig,
  token: string,
  defaultModel: string
): PiProfileConfigWriteResult {
  const profileHome = resolvePiAgentDir(configDir, profile);
  const sessionDir = resolvePiSessionDir(configDir, profile);
  const file = path.join(profileHome, "models.json");
  const providerId = sanitizeProviderId(profile.providerId || "") || "claude-code-router";
  const models = piProfileModels(config, defaultModel);
  const model = models.includes(defaultModel) ? defaultModel : models[0] || defaultModel || "default";
  const content = `${JSON.stringify(piModelsJson(config, profile, providerId, token, models), null, 2)}\n`;
  const changed = writeJsonFileIfChanged(file, content);
  mkdirSync(sessionDir, { mode: privateDirMode, recursive: true });
  chmodPrivateDir(profileHome);
  chmodPrivateDir(sessionDir);
  return {
    changed,
    file,
    model,
    profileHome,
    providerId,
    sessionDir
  };
}

function piModelsJson(
  config: AppConfig,
  profile: ProfileConfig,
  providerId: string,
  token: string,
  models: string[]
): Record<string, unknown> {
  return {
    providers: {
      [providerId]: {
        api: "openai-responses",
        apiKey: token,
        authHeader: true,
        baseUrl: `${gatewayEndpoint(config).replace(/\/+$/g, "")}/v1`,
        headers: {
          "x-ccr-client": "pi",
          "x-ccr-profile": profile.id || profile.name || "pi"
        },
        models: models.map((m) => piModelConfig(config, m))
      }
    }
  };
}

function piModelConfig(config: AppConfig, model: string): Record<string, unknown> {
  const contextWindow = piProfileModelContextWindow(config, model);
  return {
    id: model,
    name: model,
    ...(contextWindow !== undefined ? { contextWindow } : {})
  };
}

function piProfileModels(config: AppConfig, defaultModel: string): string[] {
  return uniqueStrings([
    defaultModel,
    ...buildCodexModelCatalogIds(config, defaultModel)
  ].filter(Boolean));
}

function piProfileModelContextWindow(
  config: AppConfig,
  modelSelector: string
): number | undefined {
  const resolved = modelRegistryForConfig(config).resolveProviderModel(modelSelector);
  // Prefer provider modelMetadata (maxContextWindow, then contextWindow).
  const configured = resolved?.provider.modelMetadata?.[resolved.model];
  const window = configured?.maxContextWindow ?? configured?.contextWindow;
  if (window && window > 0) {
    return window;
  }
  // Fall back to the static model catalog (knows anthropic/deepseek/z.ai sizes),
  // then omit entirely so pi keeps its own 128k default for truly-unknown models
  // — never guess a value we cannot source.
  const catalogSelector = resolved ? `${resolved.provider.name}/${resolved.model}` : modelSelector;
  const entry = findModelCatalogEntry(catalogSelector) ?? findModelCatalogEntry(modelSelector);
  const catalogWindow = modelCatalogMaxInputTokens(entry);
  return catalogWindow > 0 ? catalogWindow : undefined;
}

function gatewayEndpoint(config: AppConfig): string {
  const host = config.gateway.host === "0.0.0.0" || config.gateway.host === "::" ? "127.0.0.1" : config.gateway.host;
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${normalizedHost}:${config.gateway.port}`;
}

function writeJsonFileIfChanged(file: string, content: string): boolean {
  mkdirSync(path.dirname(file), { mode: privateDirMode, recursive: true });
  chmodPrivateDir(path.dirname(file));
  const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (previous === content) {
    chmodPrivateFile(file);
    return false;
  }
  writeFileSync(file, content, { encoding: "utf8", mode: privateFileMode });
  chmodPrivateFile(file);
  return true;
}

function chmodPrivateDir(dir: string): void {
  if (process.platform === "win32" || !existsSync(dir)) {
    return;
  }
  try {
    chmodSync(dir, privateDirMode);
  } catch {
    // Best-effort permissions only; config writes should not fail after success.
  }
}

function chmodPrivateFile(file: string): void {
  if (process.platform === "win32" || !existsSync(file)) {
    return;
  }
  try {
    chmodSync(file, privateFileMode);
  } catch {
    // Best-effort permissions only; config writes should not fail after success.
  }
}

function uniqueStrings(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function sanitizeProviderId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function sanitizePathSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveUserPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return homeDir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir(), trimmed.slice(2));
  }
  return path.resolve(trimmed || ".");
}

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir() || ".";
}
