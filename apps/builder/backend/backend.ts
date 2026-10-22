// selfhost: the Builder's disposable e2e database (Postgres in Docker), driven from Node so
// it works the same on macOS, Linux and Windows. Used by the e2e runner (e2e/run.ts) and
// `pnpm backend <mode> <compose args>` (backend/run.ts). Running the builder day to day is
// knowbra-webstudio's job.
//
// Modes pick a Compose override next to this file; both keep their data in tmpfs.
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const rootDir = join(import.meta.dirname, "../../..");

/** Environment variables (process.env, or a copy with overrides). */
export type Env = Record<string, string | undefined>;

export const backendModes = ["test", "snapshot"] as const;
export type BackendMode = (typeof backendModes)[number];

export const isBackendMode = (value: string): value is BackendMode =>
  (backendModes as readonly string[]).includes(value);

type RunOptions = {
  cwd?: string;
  env?: Env;
  /** Collect stdout instead of showing it. */
  capture?: boolean;
  /** Hide all output (still collected when capture is set). */
  quiet?: boolean;
  /** A file to feed to stdin. */
  stdinFile?: string;
  /** A file to write stdout to. */
  stdoutFile?: string;
  /** Run through the shell; needed for .cmd shims such as pnpm on Windows. */
  shell?: boolean;
};

const isWindows = process.platform === "win32";

let processGroups = false;

/**
 * Starts later run() children in their own process group (POSIX), so killTree
 * reaches their descendants. Ctrl+C then no longer reaches them directly: callers
 * must stopRunningChildren on SIGINT. The e2e runner uses this for step timeouts.
 */
export const enableProcessGroups = () => {
  processGroups = true;
};

/** Programs started by run() that are still running, for killTree on timeouts. */
export const runningChildren = new Set<ChildProcess>();

/** Stops a child and everything it started. */
export const killTree = (
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM"
) => {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    // With enableProcessGroups the child leads its own group, so this reaches
    // descendants such as apt-get too.
    process.kill(processGroups ? -child.pid : child.pid, signal);
  } catch {
    child.kill(signal);
  }
};

/** Runs a program without a shell and resolves with its exit code and captured stdout. */
export const run = (
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve, reject) => {
    const fds: number[] = [];
    const open = (file: string, flags: string) => {
      const fd = openSync(file, flags);
      fds.push(fd);
      return fd;
    };
    const stdio: StdioOptions = [
      options.stdinFile === undefined ? "ignore" : open(options.stdinFile, "r"),
      options.stdoutFile !== undefined
        ? open(options.stdoutFile, "w")
        : options.capture
          ? "pipe"
          : options.quiet
            ? "ignore"
            : "inherit",
      options.quiet ? "ignore" : "inherit",
    ];
    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd ?? rootDir,
      env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      stdio,
      shell: options.shell,
      detached: processGroups && isWindows === false,
    });
    runningChildren.add(child);
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const closeFds = () => fds.forEach((fd) => closeSync(fd));
    child.on("error", (error: Error) => {
      runningChildren.delete(child);
      closeFds();
      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`${command} not found. Is it installed and on PATH?`)
          : error
      );
    });
    child.on("close", (code) => {
      runningChildren.delete(child);
      closeFds();
      resolve({ code: code ?? 1, stdout });
    });
  });

/** Stops every running child; call on SIGINT/SIGTERM in scripts that use run(). */
export const stopRunningChildren = () => {
  for (const child of runningChildren) {
    killTree(child);
  }
};

/** pnpm from PATH (the root devDependency under npm run). */
export const pnpm = (args: string[], options: RunOptions = {}) =>
  runChecked(isWindows ? "pnpm.cmd" : "pnpm", args, {
    ...options,
    shell: isWindows,
  });

/** Like run, but rejects when the program fails. */
export const runChecked = async (
  command: string,
  args: string[],
  options: RunOptions = {}
) => {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${[command, ...args].join(" ")} failed with exit code ${result.code}`
    );
  }
  return result;
};

/** Finds a package's directory as Node resolution would, from `fromDir` upwards. */
const findPackageDir = (fromDir: string, packageName: string) => {
  for (let directory = fromDir; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", packageName);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    if (dirname(directory) === directory) {
      throw new Error(`${packageName} is not installed (run npm run setup)`);
    }
  }
};

/** The JS entry of a package's bin, run with this Node (no .cmd shims on Windows). */
export const resolveBin = (
  fromDir: string,
  packageName: string,
  bin: string
) => {
  const packageDir = findPackageDir(fromDir, packageName);
  const packageJson = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8")
  ) as { bin?: string | Record<string, string> };
  const entry =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.[bin];
  if (entry === undefined) {
    throw new Error(`${packageName} has no ${bin} bin`);
  }
  return join(packageDir, entry);
};

/** Runs drizzle-kit from packages/db (its config reads DIRECT_URL or DATABASE_URL). */
export const drizzleKitArgs = (root = rootDir) => [
  resolveBin(join(root, "packages/db"), "drizzle-kit", "drizzle-kit"),
];

const listFiles = (directory: string): string[] => {
  if (existsSync(directory) === false) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : entry.isFile() ? [path] : [];
  });
};

/**
 * Identifies the schema the migrations and backend files produce, so a cached
 * schema snapshot is reused only while they're unchanged.
 */
export const schemaFingerprint = (root = rootDir) => {
  const files = [
    ...listFiles(join(root, "packages/db/drizzle")),
    ...listFiles(join(root, "apps/builder/backend")).filter(
      (file) => /\.test\./.test(file) === false
    ),
  ]
    .map((file) => relative(root, file).split(sep).join("/"))
    .sort();
  const hash = createHash("sha1");
  for (const file of files) {
    const content = createHash("sha1")
      .update(readFileSync(join(root, file)))
      .digest("hex");
    hash.update(`${file} ${content}\n`);
  }
  return hash.digest("hex");
};

const psql = (sql: string, extra = "") =>
  `PGPASSWORD="$POSTGRES_PASSWORD" psql -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 ${extra} ${sql}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const createBackend = ({
  mode,
  root = rootDir,
  env = process.env,
}: {
  mode: BackendMode;
  root?: string;
  env?: Env;
}) => {
  const backendDir = join(root, "apps/builder/backend");
  const projectName = env.COMPOSE_PROJECT_NAME || "builder-e2e";
  const envFiles = [".env", ".env.development"]
    .map((file) => join(root, "apps/builder", file))
    .filter((file) => existsSync(file));
  const composeArgs = [
    "compose",
    "--project-name",
    projectName,
    ...envFiles.flatMap((file) => ["--env-file", file]),
    "-f",
    join(backendDir, "compose.yaml"),
    "-f",
    join(backendDir, `compose.${mode}.yaml`),
  ];
  const schemaSnapshot =
    env.SCHEMA_SNAPSHOT ||
    join(root, ".cache/builder-e2e", `schema-${schemaFingerprint(root)}.sql`);

  const compose = (args: string[], options: RunOptions = {}) =>
    run("docker", [...composeArgs, ...args], { env, ...options });
  const composeChecked = (args: string[], options: RunOptions = {}) =>
    runChecked("docker", [...composeArgs, ...args], { env, ...options });
  const execDb = (script: string, options: RunOptions = {}) =>
    compose(["exec", "-T", "db", "sh", "-c", script], options);

  const schemaExists = async () => {
    const { code, stdout } = await execDb(
      psql(`-tAc "SELECT to_regclass('public.\\"Project\\"') IS NOT NULL"`),
      { capture: true }
    );
    return code === 0 && stdout.trim() === "t";
  };

  const migrate = async () => {
    await runChecked(process.execPath, [...drizzleKitArgs(root), "migrate"], {
      cwd: join(root, "packages/db"),
      env,
    });
    if ((await schemaExists()) === false) {
      throw new Error(
        "Migrations completed without creating the Builder schema"
      );
    }
  };

  const bootstrapSchemaSnapshot = async () => {
    if (existsSync(schemaSnapshot) === false) {
      throw new Error(`No cached schema at ${schemaSnapshot}`);
    }
    const { code } = await execDb(psql(""), {
      stdinFile: schemaSnapshot,
      quiet: true,
    });
    if (code !== 0) {
      throw new Error(`Restoring ${schemaSnapshot} failed`);
    }
  };

  const writeSchemaSnapshot = async () => {
    mkdirSync(dirname(schemaSnapshot), { recursive: true });
    const temporary = `${schemaSnapshot}.tmp.${process.pid}`;
    // Dump the application schema and drizzle-kit's migration journal, so later
    // migrations apply on top of a restored snapshot.
    const { code } = await execDb(
      'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema=public --schema=drizzle --clean --if-exists --no-owner --no-privileges',
      { stdoutFile: temporary }
    );
    if (code !== 0) {
      rmSync(temporary, { force: true });
      throw new Error("pg_dump failed");
    }
    renameSync(temporary, schemaSnapshot);
    console.info(`Wrote ${schemaSnapshot}`);
  };

  const bootstrap = async (kind: "schema" | "migrations" | "auto" = "auto") => {
    if (kind === "schema") {
      return bootstrapSchemaSnapshot();
    }
    if (kind === "migrations") {
      return migrate();
    }
    if (existsSync(schemaSnapshot)) {
      await bootstrapSchemaSnapshot();
      console.info(
        `Bootstrapped database from cached schema ${schemaSnapshot}`
      );
    } else {
      console.info(
        `No cached schema found at ${schemaSnapshot}; running migrations`
      );
      await migrate();
      await writeSchemaSnapshot();
    }
  };

  return {
    mode,
    projectName,
    schemaSnapshot,
    compose,
    composeChecked,

    down: (...args: string[]) => composeChecked(["down", ...args]),

    pullDb: () => composeChecked(["pull", "--policy", "missing", "db"]),

    buildDb: () => composeChecked(["build", "--pull", "db"]),

    start: () => composeChecked(["up", "-d", "db"]),

    waitForDb: async (timeoutSeconds = 60) => {
      const timeoutAt = Date.now() + timeoutSeconds * 1000;
      // Connect over TCP, not the unix socket: the postgres image's entrypoint
      // runs a temporary socket-only server (listen_addresses='') during init,
      // which lets a socket probe pass while host clients (drizzle-kit migrate)
      // still get connection refused.
      while (
        (await execDb(psql('-c "SELECT 1"'), { quiet: true })).code !== 0
      ) {
        if (Date.now() >= timeoutAt) {
          throw new Error("Timed out waiting for database");
        }
        await sleep(200);
      }
    },

    schemaExists,
    migrate,
    bootstrap,

    bootstrapIfEmpty: async () => {
      if (await schemaExists()) {
        console.info("Database schema already exists; skipping bootstrap");
      } else {
        await bootstrap("auto");
      }
    },

    writeSchemaSnapshot,
  };
};

export type Backend = ReturnType<typeof createBackend>;
