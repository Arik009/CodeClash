// Backs up the compose `mongo` service; restores touch only the codeclash and codeclash_audit databases.
//   npm run backup                          -> backups/codeclash-<time>.archive.gz, keeps the newest KEEP (7)
//   npm run backup -- restore <file>        -> mongorestore --drop from that archive
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.env.BACKUP_DIR ?? 'backups');
const keep = Number(process.env.KEEP ?? 7);
const auth = ['-u', process.env.MONGO_ROOT_USER ?? 'root', '-p', process.env.MONGO_ROOT_PASSWORD ?? 'codeclash', '--authenticationDatabase', 'admin'];

function run(args, { stdin, stdout }) {
  return new Promise((done, fail) => {
    const child = spawn('docker', ['compose', 'exec', '-T', 'mongo', ...args], { stdio: [stdin ? 'pipe' : 'ignore', stdout ? 'pipe' : 'inherit', 'inherit'] });
    if (stdin) stdin.pipe(child.stdin);
    if (stdout) child.stdout.pipe(stdout);
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`${args[0]} exited with ${code}`))));
  });
}

async function backup() {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `codeclash-${new Date().toISOString().replace(/[:.]/g, '-')}.archive.gz`);
  const out = createWriteStream(file);
  await run(['mongodump', ...auth, '--archive', '--gzip'], { stdout: out });
  await new Promise((done) => out.close(done));
  console.log(`backup written: ${file} (${statSync(file).size} bytes)`);
  const old = readdirSync(dir).filter((name) => name.endsWith('.archive.gz')).sort().reverse().slice(keep);
  for (const name of old) rmSync(join(dir, name));
  if (old.length) console.log(`removed ${old.length} older backup(s)`);
}

async function restore(file) {
  if (!file) throw new Error('usage: npm run backup -- restore <file>');
  await run(['mongorestore', ...auth, '--nsInclude=codeclash.*', '--nsInclude=codeclash_audit.*', '--archive', '--gzip', '--drop'], { stdin: createReadStream(resolve(file)) });
  console.log(`restored from ${file}`);
}

const [command, file] = process.argv.slice(2);
(command === 'restore' ? restore(file) : backup()).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
