#!/usr/bin/env node
import { ADMIN_COMMANDS, ADMIN_USAGE, adminMain } from './cli/admin.js';
import { CLIENT_COMMANDS, CLIENT_USAGE, clientMain } from './cli/client.js';

const USAGE = `Usage: spall <command> [options]   (spall <command> --help)

${CLIENT_USAGE}
${ADMIN_USAGE}`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Options that take a value, so their value isn't mistaken for the command. */
const VALUE_OPTIONS = new Set(['-c', '--config', '--url']);

/** The command is the first positional: `spall -c spall.yaml check` works as well as `spall check -c …`. */
function splitCommand(args: string[]): [string | undefined, string[]] {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUE_OPTIONS.has(a)) i++;
    else if (!a.startsWith('-')) return [a, [a, ...args.slice(0, i), ...args.slice(i + 1)]];
  }
  return [undefined, args];
}

const [cmd, argv] = splitCommand(process.argv.slice(2));

if (cmd !== undefined && ADMIN_COMMANDS.includes(cmd)) {
  adminMain(argv).catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
} else if (cmd !== undefined && CLIENT_COMMANDS.includes(cmd)) {
  clientMain(argv, {
    env: process.env,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    stdin: readStdin,
  }).then((code) => {
    if (code !== null) process.exitCode = code;
  });
} else if (cmd === undefined || cmd === 'help') {
  console.log(USAGE);
} else {
  console.error(`spall: unknown command ${cmd}\n\n${USAGE}`);
  process.exitCode = 2;
}
