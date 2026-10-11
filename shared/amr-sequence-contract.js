export const AMR_SEQUENCE_CONTRACT_VERSION = 'amr-sequence-contract-1';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FASTA_NAME_PATTERN = /\.(?:fa|fna|fasta)(?:\.gz)?$/i;
const FEATURE_TYPES = new Set(['acquired_gene', 'mutation', 'unknown']);
const FEATURE_EVIDENCE = new Set(['sequence_caller', 'manual_review', 'unknown']);

export const AMR_SEQUENCE_INPUT_SCHEMA = Object.freeze({
  contract_version: AMR_SEQUENCE_CONTRACT_VERSION,
  input_type: 'fasta',
  required: ['filename', 'content_sha256', 'preflight_report'],
  transport: 'raw FASTA bytes are staged or transferred separately; this manifest binds the bytes to the preflight report',
});

export const AMR_NORMALIZED_FEATURE_SCHEMA = Object.freeze({
  contract_version: AMR_SEQUENCE_CONTRACT_VERSION,
  required: ['genome_id', 'organism', 'features'],
  feature_fields: ['determinant', 'type', 'evidence', 'tool_name', 'tool_version', 'database_name', 'database_version'],
});

export function validateAmrSequenceInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['Input must be an object.'];
  if (input.contract_version !== AMR_SEQUENCE_CONTRACT_VERSION) errors.push(`contract_version must be ${AMR_SEQUENCE_CONTRACT_VERSION}.`);
  if (input.input_type !== 'fasta') errors.push('input_type must be fasta.');
  if (typeof input.filename !== 'string' || !FASTA_NAME_PATTERN.test(input.filename)) errors.push('filename must end in .fa, .fna, .fasta, or a gzip variant.');
  if (typeof input.content_sha256 !== 'string' || !SHA256_PATTERN.test(input.content_sha256)) errors.push('content_sha256 must be a lowercase SHA-256 hex digest.');
  const report = input.preflight_report;
  if (!report || typeof report !== 'object' || Array.isArray(report)) errors.push('preflight_report is required.');
  else {
    if (report.report_version !== 'fasta-preflight-1') errors.push('preflight_report.report_version is unsupported.');
    if (report.fasta_status !== 'valid') errors.push('preflight_report.fasta_status must be valid.');
    if (report.input_sha256 !== input.content_sha256) errors.push('preflight_report.input_sha256 must match content_sha256.');
    if (!Number.isInteger(report.contig_count) || report.contig_count < 1) errors.push('preflight_report.contig_count must be a positive integer.');
    if (!Number.isInteger(report.total_bases) || report.total_bases < 1) errors.push('preflight_report.total_bases must be a positive integer.');
  }
  return errors;
}

export function validateAmrNormalizedFeatures(output) {
  const errors = [];
  if (!output || typeof output !== 'object' || Array.isArray(output)) return ['Output must be an object.'];
  if (output.contract_version !== AMR_SEQUENCE_CONTRACT_VERSION) errors.push(`contract_version must be ${AMR_SEQUENCE_CONTRACT_VERSION}.`);
  if (typeof output.genome_id !== 'string' || !output.genome_id.trim()) errors.push('genome_id is required.');
  if (!output.organism || typeof output.organism !== 'object') errors.push('organism evidence is required.');
  if (!Array.isArray(output.features)) errors.push('features must be an array.');
  else output.features.forEach((feature, index) => {
    if (!feature || typeof feature !== 'object') return errors.push(`features[${index}] must be an object.`);
    if (typeof feature.determinant !== 'string' || !feature.determinant.trim()) errors.push(`features[${index}].determinant is required.`);
    if (!FEATURE_TYPES.has(feature.type)) errors.push(`features[${index}].type is unsupported.`);
    if (!FEATURE_EVIDENCE.has(feature.evidence)) errors.push(`features[${index}].evidence is unsupported.`);
    if (feature.evidence === 'sequence_caller' && (!feature.tool_name || !feature.tool_version || !feature.database_version)) errors.push(`features[${index}] sequence_caller evidence requires tool and database versions.`);
  });
  return errors;
}
