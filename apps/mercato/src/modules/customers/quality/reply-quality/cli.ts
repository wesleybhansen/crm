import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runDryReplyQuality } from "./runner";
import { runScoredReplyQuality } from "./scored";

type CliMode = "dry" | "scored";

type CliOptions = {
  mode: CliMode;
  outputPath: string;
};

export function parseReplyQualityCliOptions(
  argumentsList: string[],
): CliOptions {
  let mode: CliMode = "dry";
  let outputPath: string | null = null;

  for (const argument of argumentsList) {
    if (argument.startsWith("--mode=")) {
      const value = argument.slice("--mode=".length);
      if (value !== "dry" && value !== "scored") {
        throw new Error("--mode must be dry or scored");
      }
      mode = value;
      continue;
    }
    if (argument.startsWith("--output=")) {
      const value = argument.slice("--output=".length).trim();
      if (!value) throw new Error("--output requires a path");
      outputPath = value;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    mode,
    outputPath: resolve(
      outputPath ?? (mode === "dry" ? "dry-run.json" : "scored.json"),
    ),
  };
}

async function main(): Promise<void> {
  try {
    const options = parseReplyQualityCliOptions(process.argv.slice(2));
    const result =
      options.mode === "dry"
        ? runDryReplyQuality()
        : await runScoredReplyQuality();
    const serialized = `${JSON.stringify(result, null, 2)}\n`;

    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, serialized, "utf8");
    const consoleSummary =
      result.mode === "dry-run"
        ? {
            mode: result.mode,
            status: result.status,
            outputPath: options.outputPath,
            ...result.summary,
            failureCount: result.failures.length,
          }
        : {
            mode: result.mode,
            status: result.status,
            reason: result.reason,
            outputPath: options.outputPath,
            maxCases: result.maxCases,
            callsMade: result.callsMade,
            ...result.summary,
          };
    process.stdout.write(`${JSON.stringify(consoleSummary)}\n`);
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown reply-quality CLI error";
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: "reply-quality-result.v1",
        mode: "cli",
        status: "failed",
        error: message,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void main();
