import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const migrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));
export const AMR_MODEL_VERSION = process.env.AMR_MODEL_VERSION || 'amr-sgd-feature-baseline-1';
export const AMR_DATASET_VERSION = process.env.AMR_DATASET_VERSION || 'amr-baseline-cohort-a3c7b549296846c1';
export const HPO_MODEL_VERSION = 'hpo-resnik-baseline-1';
export const ANALYSIS_RETENTION_DAYS = Number(process.env.ANALYSIS_RETENTION_DAYS || '90');

if (!Number.isInteger(ANALYSIS_RETENTION_DAYS) || ANALYSIS_RETENTION_DAYS < 1 || ANALYSIS_RETENTION_DAYS > 3650) {
  throw new Error('ANALYSIS_RETENTION_DAYS must be an integer from 1 to 3650.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function migrateDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      await client.query('BEGIN');
      try {
        const applied = await client.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          [file],
        );
        if (applied.rowCount) {
          await client.query('COMMIT');
          continue;
        }

        const migration = await readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8');
        await client.query(migration);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

export async function registerModelVersions(hpoMetadata) {
  await pool.query(
    `UPDATE model_versions
     SET description = 'Deprecated phrase-overlap demo; retained only for historical analysis records.',
         metadata = metadata || $1::jsonb
     WHERE version = 'PHENO-OVERLAP-DEMO-01'`,
    [JSON.stringify({ deprecated: true, replaced_by: HPO_MODEL_VERSION })],
  );

  await pool.query(
    `INSERT INTO model_versions (version, family, description, metadata)
     VALUES ($1, 'amr', 'Trained SGD feature baseline; research use only and not calibrated.', $2::jsonb)
     ON CONFLICT (version) DO NOTHING`,
    [
      AMR_MODEL_VERSION,
      JSON.stringify({
        mode: 'trained_baseline_uncalibrated',
        artifact_path: 'data/models/amr_feature_baseline.joblib',
        sha256: process.env.AMR_MODEL_SHA256 || '829b68359ac0b2d65cf22be19643be4435c786d0e8aade40af94ba58bf9b94d9',
        validation_threshold: 0.2,
        test_records: 15660,
        test_auroc: 0.793810242697639,
        test_auprc: 0.6659603913130197,
        test_expected_calibration_error: 0.13683754428257264,
      }),
    ],
  );

  await pool.query(
    `INSERT INTO model_versions (version, family, description, metadata)
     VALUES ($1, 'rare_disease', 'Resnik-style HPO profile ranker; research use only and not a clinical diagnostic.', $2::jsonb)
     ON CONFLICT (version) DO UPDATE SET family = EXCLUDED.family, description = EXCLUDED.description, metadata = EXCLUDED.metadata`,
    [HPO_MODEL_VERSION, JSON.stringify({ mode: 'hpo_resnik_relative_ranking', dataset_version: hpoMetadata.dataset_version })],
  );

  await pool.query(
    `INSERT INTO dataset_versions (version, source, sha256, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (version) DO UPDATE
     SET source = EXCLUDED.source, sha256 = EXCLUDED.sha256, metadata = EXCLUDED.metadata`,
    [
      AMR_DATASET_VERSION,
      'data/amr_2m/processed/amr_baseline_cohort.jsonl',
      process.env.AMR_DATASET_SHA256 || 'a3c7b549296846c61eca74d2733c048fcbf1a2aa809f11c86fe673e7bdf6141e',
      JSON.stringify({
        storage: 'versioned file; not imported into PostgreSQL',
        records: 77380,
        split_counts: { train: 54041, validation: 7679, test: 15660 },
        purpose: 'trained AMR baseline cohort',
      }),
    ],
  );

  await pool.query(
    `INSERT INTO dataset_versions (version, source, sha256, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (version) DO UPDATE
     SET source = EXCLUDED.source, sha256 = EXCLUDED.sha256, metadata = EXCLUDED.metadata`,
    [
      hpoMetadata.dataset_version,
      'data/rare_disease/processed/ (profiles, HPO graph, term index)',
      hpoMetadata.dataset_sha256,
      JSON.stringify({
        storage: 'versioned read-only files; not imported into PostgreSQL',
        artifacts: hpoMetadata.artifacts,
        purpose: 'HPO disease-profile ranking and phenotype normalization',
      }),
    ],
  );
}

export async function createAnalysis({ workflow, inputData, modelVersion, datasetVersion = null }) {
  const result = await pool.query(
    `INSERT INTO analysis_runs (workflow, status, input_data, model_version, dataset_version)
     VALUES ($1, 'running', $2::jsonb, $3, $4)
     RETURNING id`,
    [workflow, JSON.stringify(inputData), modelVersion, datasetVersion],
  );
  return result.rows[0].id;
}

export async function completeAnalysis(id, resultData) {
  await pool.query(
    `UPDATE analysis_runs
     SET status = 'completed', result_data = $2::jsonb, completed_at = now()
     WHERE id = $1`,
    [id, JSON.stringify(resultData)],
  );
}

export async function failAnalysis(id, message) {
  await pool.query(
    `UPDATE analysis_runs SET status = 'failed', error_message = $2, completed_at = now() WHERE id = $1`,
    [id, message.slice(0, 1000)],
  );
}

export async function purgeExpiredAnalyses(retentionDays = ANALYSIS_RETENTION_DAYS) {
  const result = await pool.query(
    `DELETE FROM analysis_runs
     WHERE created_at < now() - ($1::integer * interval '1 day')`,
    [retentionDays],
  );
  return result.rowCount;
}
