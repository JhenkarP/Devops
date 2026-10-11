import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AMR_SEQUENCE_CONTRACT_VERSION, validateAmrSequenceInput } from '../shared/amr-sequence-contract.js';

const execFileAsync = promisify(execFile);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function value(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function usage() {
  console.log('Usage: node scripts/run-amrfinder-plus.mjs --binary <amrfinder> --database <db> --input <fasta> --preflight <manifest.json> --output <results.tsv> --run-manifest <run.json> --tool-version <version> --database-version <version>');
}

export async function runAmrfinder(args) {
  const binary = value(args, '--binary');
  const database = value(args, '--database');
  const input = value(args, '--input');
  const preflightPath = value(args, '--preflight');
  const output = value(args, '--output');
  const runManifestPath = value(args, '--run-manifest');
  const toolVersion = value(args, '--tool-version');
  const databaseVersion = value(args, '--database-version');
  if (!binary || !database || !input || !preflightPath || !output || !runManifestPath || !toolVersion || !databaseVersion) {
    throw new Error('Binary, database, input, preflight manifest, output, run manifest, tool version, and database version are required.');
  }
  const preflight = JSON.parse(await readFile(resolve(preflightPath), 'utf8'));
  const inputBytes = await readFile(resolve(input));
  const inputManifest = {
    contract_version: AMR_SEQUENCE_CONTRACT_VERSION,
    input_type: 'fasta',
    filename: input.split(/[\\/]/).pop(),
    content_sha256: sha256(inputBytes),
    preflight_report: preflight.preflight_report || preflight,
  };
  const errors = validateAmrSequenceInput(inputManifest);
  if (errors.length) throw new Error(`Preflight binding failed: ${errors.join(' ')}`);
  const commandArgs = ['-n', resolve(input), '-o', resolve(output), '-d', resolve(database)];
  const startedAt = new Date().toISOString();
  let stdout = '';
  let stderr = '';
  let exitStatus = 'failed';
  try {
    const result = await execFileAsync(binary, commandArgs, { maxBuffer: 10 * 1024 * 1024 });
    stdout = result.stdout || '';
    stderr = result.stderr || '';
    exitStatus = 'completed';
  } catch (error) {
    stdout = error.stdout || '';
    stderr = error.stderr || error.message;
    throw error;
  } finally {
    const outputBytes = await readFile(resolve(output)).catch(() => Buffer.alloc(0));
    const runManifest = {
      contract_version: AMR_SEQUENCE_CONTRACT_VERSION,
      status: exitStatus,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      input: { filename: inputManifest.filename, sha256: inputManifest.content_sha256, preflight_report_version: inputManifest.preflight_report.report_version },
      caller: { tool_name: 'AMRFinderPlus', tool_version: toolVersion, database: resolve(database), database_version: databaseVersion },
      command: { binary: resolve(binary), args: commandArgs },
      output: { filename: output.split(/[\\/]/).pop(), sha256: sha256(outputBytes), bytes: outputBytes.length },
      stdout,
      stderr,
      phenotype_status: 'not_predicted',
      limitations: ['AMRFinderPlus output identifies sequence determinants; it does not establish phenotypic resistance or susceptibility.'],
    };
    await writeFile(resolve(runManifestPath), `${JSON.stringify(runManifest, null, 2)}\n`, { flag: 'wx' });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) usage();
  else runAmrfinder(process.argv.slice(2)).catch(error => {
    console.error(`AMRFinderPlus execution failed: ${error.message}`);
    process.exitCode = 1;
  });
}
