// Test double for the Antigravity CLI. Behaviour is picked by env FAKE_AGY_MODE.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const mode = process.env.FAKE_AGY_MODE ?? 'ok';
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write(`${process.env.FAKE_AGY_VERSION ?? '1.4.7'}\n`);
  process.exit(0);
}
const envelope = (response, extra = {}) =>
  JSON.stringify({
    conversation_id: 'fake-conv',
    status: 'SUCCESS',
    response,
    duration_seconds: 0.1,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 },
    ...extra,
  });

switch (mode) {
  case 'ok':
    process.stdout.write(envelope('Migrations are defined in db/migrate/001_init.sql:1') + '\n');
    break;
  case 'args':
    process.stdout.write(envelope(JSON.stringify(argv)) + '\n');
    break;
  case 'env':
    process.stdout.write(envelope(JSON.stringify(process.env)) + '\n');
    break;
  case 'notloggedin':
    process.stderr.write('error: You are not logged into Antigravity.\n');
    process.exitCode = 1;
    break;
  case 'cwd':
    process.stdout.write(envelope(process.cwd()) + '\n');
    break;
  case 'empty':
    process.stdout.write(envelope('', { denied_actions: [{ action: 'read_file', display_name: 'ListDir' }] }) + '\n');
    process.stderr.write('jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.\n');
    break;
  case 'garbage':
    process.stdout.write('this is not json\n');
    break;
  case 'signedout':
    process.stdout.write(JSON.stringify({ conversation_id: '', status: 'ERROR', response: '', error: 'Authentication expired. Please log back in.' }) + '\n');
    process.stderr.write('error: Authentication expired. Please log back in.\n');
    process.exitCode = 1;
    break;
  case 'quota':
    process.stderr.write('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"error_id":"fake"}\n');
    process.stderr.write('error: Your AI credits balance is too low to continue.\n');
    process.exitCode = 3;
    break;
  case 'unknownagent':
    process.stdout.write(JSON.stringify({ conversation_id: '', status: 'ERROR', response: '', error: 'unknown agent "x" (available: a, b)' }) + '\n');
    process.stderr.write('error: unknown agent "x" (available: a, b)\n');
    process.exitCode = 1;
    break;
  case 'hang': {
    // A grandchild that also hangs, so the test can check the whole tree is killed.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (process.env.FAKE_AGY_PIDFILE) fs.writeFileSync(process.env.FAKE_AGY_PIDFILE, JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
    break;
  }
  default:
    process.stderr.write(`fake-agy: unknown FAKE_AGY_MODE ${mode}\n`);
    process.exitCode = 2;
}
