import { runConsumer } from "./consumer";
import { loadConfig } from "./config";
import { startBridge } from "./server";

const USAGE = `muse-bridge

Usage:
  bun src/cli.ts serve                    start the OpenAI API + consumer hub
  bun src/cli.ts consume [options]        bridge one SSH session to the hub

Options (consume):
  --hub <url>     consumer hub URL   (default: ws://<HUB_HOST>:<HUB_PORT>)
  --id   <name>   consumer identity  (default: muse-<pid>)

Environment: HOST PORT HUB_HOST HUB_PORT DB_PATH MAX_DEPTH DEADLINE_MS
             LEASE_MS HEARTBEAT_MS HEARTBEAT_TIMEOUT_MS MAX_ATTEMPTS`;

function parseArgs(argv: string[]): {
  cmd?: string;
  hub?: string;
  id?: string;
} {
  const [cmd, ...rest] = argv;
  const out: { cmd?: string; hub?: string; id?: string } = { cmd };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--hub") out.hub = rest[++i];
    else if (rest[i] === "--id") out.id = rest[++i];
    else throw new Error(`unknown argument: ${rest[i]}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  if (args.cmd === "serve") {
    const bridge = startBridge(cfg);
    console.log(
      `muse-bridge serving OpenAI API on ${cfg.host}:${bridge.publicPort} ` +
        `(consumer hub on ${cfg.hubHost}:${bridge.hubPort})`,
    );
    const shutdown = async () => {
      await bridge.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return; // Bun.serve keeps the process alive
  }

  if (args.cmd === "consume") {
    const hubUrl = args.hub ?? `ws://${cfg.hubHost}:${cfg.hubPort}`;
    const id = args.id ?? `muse-${process.pid}`;
    const code = await runConsumer(cfg, hubUrl, id);
    // the session is over; exit regardless of lingering handles
    process.exit(code);
  }

  console.error(USAGE);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
