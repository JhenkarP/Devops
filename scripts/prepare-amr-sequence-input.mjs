import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFasta } from './fasta-preflight.mjs';
import { AMR_SEQUENCE_CONTRACT_VERSION, validateAmrSequenceInput } from '../shared/amr-sequence-contract.js';

function usage() {
  console.log('Usage: node scripts/prepare-amr-sequence-input.mjs <assembly.fasta[.gz]> --output <manifest.json>');
}

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  const inputPath = args.find(argument => !argument.startsWith('-'));
  const outputIndex = args.indexOf('--output');
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
  if (!inputPath || !outputPath) throw new Error('An input FASTA and --output manifest path are required.');

  const preflightReport = await analyzeFasta(inputPath);
  const manifest = {
    contract_version: AMR_SEQUENCE_CONTRACT_VERSION,
    input_type: 'fasta',
    filename: basename(inputPath),
    content_sha256: preflightReport.input_sha256,
    preflight_report: preflightReport,
    status: 'preflight_complete_caller_not_run',
    prediction_status: 'not_run',
    limitations: [
      'This manifest validates FASTA structure and binds the input checksum to the preflight report.',
      'Assembly quality, taxonomy, resistance determinants, and phenotype have not been assessed.',
      'No AMR caller or phenotype model was run.',
    ],
  };
  const errors = validateAmrSequenceInput(manifest);
  if (errors.length) throw new Error(`Generated manifest failed validation: ${errors.join(' ')}`);
  await writeFile(resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(`FASTA intake manifest written to ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`AMR sequence intake failed: ${error.message}`);
    process.exitCode = 1;
  });
}
