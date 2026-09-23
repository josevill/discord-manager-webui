import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function getToken(flag?: string): string {
  return flag || process.env.DISCORD_TOKEN || requireEnv("DISCORD_TOKEN");
}

export function getGuildId(flag?: string): string {
  return flag || process.env.DISCORD_GUILD_ID || requireEnv("DISCORD_GUILD_ID");
}

export async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}
