import { execFile } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_DISCORD_BRIDGE_PROJECT_URL,
  CODEX_DISCORD_BRIDGE_VERSION,
} from "../../src/discord/api.js";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FD_PATH_BUILD_COMMAND = "node scripts/build-native.mjs --only fd-path";
const NATIVE_BUILD_COMMAND = "node scripts/build-native.mjs";
const PUBLIC_PROJECT_URL = "https://github.com/ksk0605/codex-discord-bridge";
const SECURITY_OVERRIDES = {
  "fast-uri": "3.1.5",
  nanoid: "3.3.17",
  postcss: "8.5.24",
  undici: "6.28.0",
} as const;
const CHECKER_RUNTIME_PACKAGES = [
  "ajv",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
] as const;

interface PackageMetadata {
  readonly dependencies?: Record<string, string>;
  readonly files?: string[];
  readonly homepage?: string;
  readonly license?: string;
  readonly os?: string[];
  readonly overrides?: Record<string, string>;
  readonly repository?: {
    readonly type?: string;
    readonly url?: string;
  };
  readonly scripts?: Record<string, string>;
  readonly version?: string;
}

interface PackFile {
  readonly mode: number;
  readonly path: string;
}

interface PackResult {
  readonly filename: string;
  readonly files: PackFile[];
}

const temporaryDirectories: string[] = [];

async function readPackageMetadata(): Promise<PackageMetadata> {
  const contents = await readFile(join(PACKAGE_ROOT, "package.json"), "utf8");
  return JSON.parse(contents) as PackageMetadata;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("native helper package contract", () => {
  it("tests supported macOS and Linux hosts without lifecycle scripts", async () => {
    const workflow = await readFile(join(PACKAGE_ROOT, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("os: [macos-latest, ubuntu-latest]");
    expect(workflow).toContain(`runs-on: \${{ matrix.os }}`);
    expect(workflow).toContain("- run: npm run native:build");
    expect(workflow).toMatch(/- run: npm run build\n\s+- run: npm run check/u);
    expect(workflow).not.toContain("protocol:check");
  });

  it("uses a platform-aware native build dispatcher before prepack validation and TypeScript output", async () => {
    const packageMetadata = await readPackageMetadata();

    expect(packageMetadata.scripts?.["native:build:fdpath"]).toBe(FD_PATH_BUILD_COMMAND);
    expect(packageMetadata.scripts?.["native:build"]).toBe(NATIVE_BUILD_COMMAND);
    expect(packageMetadata.scripts?.pretest).toBe("npm run native:build");
    expect(packageMetadata.scripts?.prepack).toBe(
      "npm run native:build && npm run check && npm test && npm run build",
    );
  });

  it("declares macOS and Linux support while shipping the macOS helper source", async () => {
    const packageMetadata = await readPackageMetadata();
    const readme = await readFile(join(PACKAGE_ROOT, "README.md"), "utf8");

    expect(packageMetadata.os).toEqual(["darwin", "linux"]);
    expect(CODEX_DISCORD_BRIDGE_PROJECT_URL).toBe(PUBLIC_PROJECT_URL);
    expect(packageMetadata.homepage).toBe(PUBLIC_PROJECT_URL);
    expect(packageMetadata.license).toBe("MIT");
    expect(packageMetadata.repository).toEqual({
      type: "git",
      url: "git+https://github.com/ksk0605/codex-discord-bridge.git",
    });
    expect(packageMetadata.overrides).toEqual(SECURITY_OVERRIDES);
    await expect(readFile(join(PACKAGE_ROOT, "LICENSE"), "utf8")).resolves.toContain("MIT License");
    expect(packageMetadata.version).toBe(CODEX_DISCORD_BRIDGE_VERSION);
    expect(packageMetadata.files).toEqual(
      expect.arrayContaining([
        "dist",
        "native/fd-path-helper.c",
        "native/keychain-helper.m",
        "scripts/build-native.mjs",
        "README.md",
        "LICENSE",
      ]),
    );
    const helperSource = await readFile(join(PACKAGE_ROOT, "native/fd-path-helper.c"), "utf8");
    expect(helperSource).toContain("F_GETPATH");
    expect(helperSource).toMatch(/fcntl\(3,\s*F_GETPATH,/u);
    expect(readme).toContain("publisher machine's current architecture");
  });

  it("succeeds without native helpers when targeting Linux", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "codex-discord-linux-native-"));
    temporaryDirectories.push(outputDirectory);

    await execFileAsync(
      process.execPath,
      ["scripts/build-native.mjs", "--output-directory", outputDirectory, "--platform", "linux"],
      { cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 10_000 },
    );

    await expect(access(join(outputDirectory, "fd-path-helper"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(outputDirectory, "keychain-helper"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  const itOnDarwin = process.platform === "darwin" ? it : it.skip;
  itOnDarwin("builds the Keychain and descriptor helpers when targeting macOS", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "codex-discord-darwin-native-"));
    temporaryDirectories.push(outputDirectory);

    await execFileAsync(
      process.execPath,
      ["scripts/build-native.mjs", "--output-directory", outputDirectory, "--platform", "darwin"],
      { cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 20_000 },
    );

    await expect(access(join(outputDirectory, "fd-path-helper"))).resolves.toBeUndefined();
    await expect(access(join(outputDirectory, "keychain-helper"))).resolves.toBeUndefined();
  });

  itOnDarwin("packs executable macOS helpers without invoking prepack", async () => {
    const packageMetadata = await readPackageMetadata();
    const packageDirectory = await mkdtemp(join(tmpdir(), "codex-discord-package-"));
    temporaryDirectories.push(packageDirectory);
    const helperPaths = [
      join(packageDirectory, "dist/native/fd-path-helper"),
      join(packageDirectory, "dist/native/keychain-helper"),
    ];

    await mkdir(join(packageDirectory, "dist/native"), { recursive: true });
    await Promise.all(
      helperPaths.map(async (helperPath) => {
        await writeFile(helperPath, "#!/bin/sh\nexit 0\n", "utf8");
        await chmod(helperPath, 0o755);
      }),
    );
    await writeFile(
      join(packageDirectory, "package.json"),
      `${JSON.stringify(packageMetadata, null, 2)}\n`,
      "utf8",
    );

    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        cwd: packageDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: join(packageDirectory, ".npm-cache"),
        },
        timeout: 10_000,
      },
    );
    const packResults = JSON.parse(stdout) as PackResult[];
    for (const helperPath of ["dist/native/fd-path-helper", "dist/native/keychain-helper"]) {
      const helper = packResults[0]?.files.find((file) => file.path === helperPath);
      expect(helper).toBeDefined();
      expect((helper?.mode ?? 0) & 0o111).not.toBe(0);
    }
  });
});

describe("protocol checker package contract", () => {
  it("loads the compiled checker from an extracted package with runtime Ajv", async () => {
    const packageMetadata = await readPackageMetadata();
    const protocolCheck = packageMetadata.scripts?.["protocol:check"] ?? "";
    const protocolCheckBuild = packageMetadata.scripts?.["protocol:check:build"] ?? "";

    expect(packageMetadata.dependencies?.ajv).toMatch(/^\^8\./u);
    expect(protocolCheck).toBe("node dist/app-server/check-protocol.js");
    expect(protocolCheckBuild).toBe("npm run build && npm run protocol:check");
    expect(protocolCheck).not.toContain("tsc");
    expect(protocolCheck).not.toContain("tsx");
    expect(protocolCheck).not.toContain("scripts/");

    await execFileAsync("npm", ["run", "build"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      timeout: 20_000,
    });
    const checker = (await import(
      pathToFileURL(join(PACKAGE_ROOT, "dist/app-server/check-protocol.js")).href
    )) as {
      checkProtocolSchemaBundle?: unknown;
    };
    expect(checker.checkProtocolSchemaBundle).toBeTypeOf("function");

    const packageDirectory = await mkdtemp(join(tmpdir(), "codex-discord-shipped-checker-"));
    temporaryDirectories.push(packageDirectory);
    const { stdout: packOutput } = await execFileAsync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packageDirectory],
      {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: join(packageDirectory, ".npm-cache"),
          npm_config_dry_run: "false",
        },
        timeout: 20_000,
      },
    );
    const packResults = JSON.parse(packOutput) as PackResult[];
    expect(packResults[0]?.files.map((file) => file.path)).toContain(
      "dist/app-server/check-protocol.js",
    );
    const tarball = join(packageDirectory, packResults[0]?.filename ?? "missing.tgz");
    await execFileAsync("tar", ["-xzf", tarball, "-C", packageDirectory], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const extractedPackage = join(packageDirectory, "package");
    const productionModules = join(extractedPackage, "node_modules");
    await mkdir(productionModules);
    await Promise.all(
      CHECKER_RUNTIME_PACKAGES.map((name) =>
        cp(join(PACKAGE_ROOT, "node_modules", name), join(productionModules, name), {
          recursive: true,
        }),
      ),
    );
    await expect(access(join(extractedPackage, "node_modules/typescript"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(extractedPackage, "node_modules/tsx"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'const checker = await import("./dist/app-server/check-protocol.js"); process.stdout.write(String(typeof checker.checkProtocolSchemaBundle) + "\\n");',
      ],
      {
        cwd: extractedPackage,
        encoding: "utf8",
        env: process.env,
        timeout: 30_000,
      },
    );
    expect(stdout).toBe("function\n");
  }, 30_000);
});
