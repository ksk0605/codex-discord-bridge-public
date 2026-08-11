import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

function argumentValue(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function parseOptions(arguments_) {
  let onlyFdPath = false;
  let outputDirectory = resolve(PACKAGE_ROOT, "dist/native");
  let platform = process.platform;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--only") {
      const value = argumentValue(arguments_, index, argument);
      if (value !== "fd-path") {
        throw new Error(`Unsupported native build target: ${value}.`);
      }
      onlyFdPath = true;
      index += 1;
      continue;
    }
    if (argument === "--output-directory") {
      outputDirectory = resolve(argumentValue(arguments_, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--platform") {
      platform = argumentValue(arguments_, index, argument);
      index += 1;
      continue;
    }
    throw new Error(`Unknown native build option: ${argument}.`);
  }

  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported native build platform: ${platform}.`);
  }
  return { onlyFdPath, outputDirectory, platform };
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: PACKAGE_ROOT,
    shell: false,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(`Native compiler failed: ${command}.`);
  }
}

function build() {
  const { onlyFdPath, outputDirectory, platform } = parseOptions(process.argv.slice(2));
  if (onlyFdPath) {
    rmSync(resolve(outputDirectory, "fd-path-helper"), { force: true });
  } else {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
  mkdirSync(outputDirectory, { recursive: true });

  if (platform === "linux") {
    return;
  }

  run("/usr/bin/clang", [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "native/fd-path-helper.c",
    "-o",
    resolve(outputDirectory, "fd-path-helper"),
  ]);
  if (!onlyFdPath) {
    run("/usr/bin/clang", [
      "-fobjc-arc",
      "-O",
      "-Wall",
      "-Wextra",
      "-Werror",
      "native/keychain-helper.m",
      "-framework",
      "Foundation",
      "-framework",
      "Security",
      "-o",
      resolve(outputDirectory, "keychain-helper"),
    ]);
  }
}

try {
  build();
} catch (error) {
  const message = error instanceof Error ? error.message : "Native helper build failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
