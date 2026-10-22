// Runs docker compose against one backend mode:
//   pnpm --filter @webstudio-is/builder backend <development|test|snapshot> <compose args...>
import { backendModes, createBackend, isBackendMode } from "./backend";

const [mode, ...args] = process.argv.slice(2);
if (mode === undefined || isBackendMode(mode) === false) {
  console.error(
    `Usage: backend <${backendModes.join("|")}> <docker compose arguments...>`
  );
  process.exit(1);
}
const { code } = await createBackend({ mode }).compose(args);
process.exit(code);
