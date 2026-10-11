import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import pg from 'pg';

const { Pool } = pg;
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const testSchema = `signallab_test_${randomUUID().replaceAll('-', '')}`;
const modelVersion = 'amr-sgd-feature-baseline-1';
const datasetVersion = 'amr-baseline-cohort-a3c7b549296846c1';
const hpoModelVersion = 'hpo-resnik-baseline-1';
const hpoDatasetVersion = `hpo-knowledge-${'a'.repeat(16)}`;
const hpoMetadata = {
	model_version: hpoModelVersion,
	dataset_version: hpoDatasetVersion,
	dataset_sha256: 'a'.repeat(64),
	artifacts: {
		profiles: { path: 'profiles.json', sha256: 'b'.repeat(64), bytes: 100 },
		graph: { path: 'graph.json', sha256: 'c'.repeat(64), bytes: 100 },
		term_index: { path: 'term-index.json', sha256: 'd'.repeat(64), bytes: 100 },
	},
};
const hpoNormalization = {
	...hpoMetadata,
	normalization: [{ input: 'developmental delay', hpo_id: 'HP:0001263', matched_term: 'Global developmental delay', match_type: 'exact_name_or_synonym', candidates: [] }],
	hpo_ids: ['HP:0001263'],
};
const hpoRank = {
	...hpoMetadata,
	input_hpo_ids: ['HP:0001263'],
	candidates: [{ disease_id: 'OMIM:1', disease_name: 'Example syndrome', score: 0.42, supporting_terms: [], contradiction_score: 0, unreported_profile_terms: [{ hpo_id: 'HP:2', term: 'Another finding' }], unreported_profile_term_count: 1 }],
	method: 'Resnik-style similarity.',
	score_semantics: 'Relative ranking score; not a probability or clinical likelihood.',
	caveat: 'Research ranking only.',
	evaluation_mode: 'hpo_resnik_relative_ranking',
};
const vocabulary = {
	vocabulary_version: 'amr-feature-vocabulary-1',
	model_version: modelVersion,
	dataset_version: datasetVersion,
	source_sha256: 'a'.repeat(64),
	source_split: 'train',
	source_records: 1,
	sha256: 'b'.repeat(64),
	organisms: ['klebsiella pneumoniae'],
	antibiotics: ['meropenem'],
	products: ['enzyme x'],
};
const prediction = {
	prediction: 'Resistance signal',
	resistance_score: 0.62,
	score_semantics: 'Uncalibrated model score; not a probability.',
	decision_threshold: 0.2,
	evidence: ['enzyme x'],
	caveat: 'Research use only; confirm with laboratory testing.',
	evaluation: { split_by: 'genome', test_records: 15660 },
	evaluation_mode: 'trained_baseline_uncalibrated',
	model_version: modelVersion,
	model_sha256: 'c'.repeat(64),
	feature_vocabulary_version: vocabulary.vocabulary_version,
	feature_vocabulary_sha256: vocabulary.sha256,
	dataset_version: datasetVersion,
	dataset_sha256: vocabulary.source_sha256,
};
const genomePanel = {
	genome_id: '573.23123',
	organism: 'klebsiella pneumoniae',
	detected_products: ['enzyme x'],
	source_feature_call_count: 2,
	source_record_count: 1,
	antibiotic_panel: [{
		antibiotic: 'meropenem',
		predicted_phenotype: 'R',
		resistance_score: 0.62,
		resistance_signal_flagged: true,
		interpretation: 'Resistance signal flagged',
		pair_evaluation: {
			records: 40,
			resistant_records: 20,
			susceptible_records: 20,
			support_status: 'descriptive_only',
			auroc: 0.9,
			auprc: 0.9,
			brier_score: 0.1,
			expected_calibration_error: 0.1,
			sensitivity: 0.8,
			specificity: 0.85,
			confidence_intervals_95: {
				auroc: [0.75, 1],
				auprc: [0.75, 1],
				sensitivity: [0.58, 0.92],
				specificity: [0.65, 0.95],
				brier_score: [0.05, 0.2],
				expected_calibration_error: [0.02, 0.2],
			},
		},
	}],
	flagged_count: 1,
	predicted_resistant_count: 1,
	predicted_susceptible_count: 0,
	panel_count: 1,
	score_semantics: 'Uncalibrated model score; not a probability.',
	decision_threshold: 0.2,
	caveat: 'Research only; confirm with laboratory testing.',
	evaluation: { split_by: 'genome', test_records: 15660 },
	evaluation_mode: 'trained_baseline_uncalibrated',
	model_version: modelVersion,
	model_sha256: 'c'.repeat(64),
	feature_vocabulary_version: vocabulary.vocabulary_version,
	feature_vocabulary_sha256: vocabulary.sha256,
	dataset_version: datasetVersion,
	dataset_sha256: vocabulary.source_sha256,
	genome_catalog_version: 'amr-bvbrc-genome-catalog-1',
	genome_catalog_sha256: 'd'.repeat(64),
	genome_source_sha256: 'e'.repeat(64),
	genome_source_snapshot: { name: 'bvbrc_genome_amr.json', sha256: 'f'.repeat(64) },
};
const genomeList = {
	catalog_version: genomePanel.genome_catalog_version,
	catalog_sha256: genomePanel.genome_catalog_sha256,
	total: 1,
	genomes: [{ genome_id: genomePanel.genome_id, organism: genomePanel.organism, detected_product_count: 1 }],
};

const state = { available: true, predictStatus: 200, genomePanelStatus: 200 };
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://signallab:signallab@127.0.0.1:5432/signallab';
const adminPool = new Pool({ connectionString: databaseUrl });
let testDatabaseUrl;
let testPool;
let mlServer;
let mlUrl;
let apiProcess;
let apiPort;
let apiOutput = '';

function sendJson(response, statusCode, body) {
	response.writeHead(statusCode, { 'Content-Type': 'application/json' });
	response.end(JSON.stringify(body));
}

async function reservePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address();
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return port;
}

async function waitForApi(child) {
	let lastError = 'API did not become healthy.';
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (child.exitCode !== null) throw new Error(`API exited before becoming healthy. ${apiOutput}`);
		try {
			const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
			if (response.ok) return;
			lastError = `API health returned ${response.status}.`;
		} catch (error) {
			lastError = error.message;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`${lastError} ${apiOutput}`);
}

async function startApi() {
	apiPort = await reservePort();
	apiOutput = '';
	const child = spawn(process.execPath, [serverPath], {
		cwd: projectRoot,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			API_HOST: '127.0.0.1',
			API_PORT: String(apiPort),
			ANALYSIS_RETENTION_DAYS: '90',
			DATABASE_URL: testDatabaseUrl,
			ML_SERVICE_URL: mlUrl,
		},
	});
	child.stdout.on('data', (chunk) => { apiOutput += chunk.toString(); });
	child.stderr.on('data', (chunk) => { apiOutput += chunk.toString(); });
	await waitForApi(child);
	return child;
}

async function stopApi() {
	if (!apiProcess || apiProcess.exitCode !== null) return;
	const child = apiProcess;
	await new Promise((resolve) => {
		child.once('exit', resolve);
		child.kill('SIGTERM');
	});
	apiProcess = undefined;
}

async function restartApi() {
	await stopApi();
	apiProcess = await startApi();
}

function api(path, options) {
	return fetch(`http://127.0.0.1:${apiPort}${path}`, options);
}

function predictRequest(overrides = {}) {
	return {
		organism: 'klebsiella pneumoniae',
		antibiotic: 'meropenem',
		products: ['enzyme x'],
		...overrides,
	};
}

test('FASTA preflight accepts valid bytes and blocks malformed sequence input', async () => {
	const validResponse = await api('/api/amr/sequence/preflight', {
		method: 'POST',
		headers: { 'Content-Type': 'application/octet-stream', 'X-SignalLab-Filename': 'upload.fasta' },
		body: Buffer.from('>contig-1\nACGTNN\n'),
	});
	assert.equal(validResponse.status, 200);
	const validResult = await validResponse.json();
	assert.equal(validResult.status, 'preflight_complete');
	assert.equal(validResult.preflight.total_bases, 6);
	assert.ok(['not_called', 'blocked_quality_gate'].includes(validResult.caller.status));
	assert.equal(validResult.model.status, 'not_called');

	const invalidResponse = await api('/api/amr/sequence/preflight', {
		method: 'POST',
		headers: { 'Content-Type': 'application/octet-stream', 'X-SignalLab-Filename': 'upload.fasta' },
		body: Buffer.from('>contig-1\nACX\n'),
	});
	assert.equal(invalidResponse.status, 400);
});

async function createAnalysis() {
	const response = await api('/api/amr/predict', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(predictRequest()),
	});
	assert.equal(response.status, 200);
	return response.json();
}

before(async () => {
	await adminPool.query(`CREATE SCHEMA "${testSchema}"`);
	const scopedUrl = new URL(databaseUrl);
	scopedUrl.searchParams.set('options', `-c search_path=${testSchema}`);
	testDatabaseUrl = scopedUrl.toString();
	testPool = new Pool({ connectionString: testDatabaseUrl });
	const schemaResult = await testPool.query('SELECT current_schema() AS schema_name');
	assert.equal(schemaResult.rows[0].schema_name, testSchema, 'API tests must use their isolated schema');

	mlServer = createServer(async (request, response) => {
		let requestBody = '';
		for await (const chunk of request) requestBody += chunk.toString();
		if (request.url === '/health') {
			return sendJson(response, state.available ? 200 : 503, { status: state.available ? 'ready' : 'unavailable' });
		}
		if (request.url?.startsWith('/amr/vocabulary')) {
			return sendJson(response, state.available ? 200 : 503, vocabulary);
		}
		if (request.url?.startsWith('/amr/genomes')) {
			return sendJson(response, state.available ? 200 : 503, genomeList);
		}
		if (request.url === '/rare-disease/metadata') {
			return sendJson(response, state.available ? 200 : 503, hpoMetadata);
		}
		if (request.url === '/rare-disease/normalize') {
			const body = JSON.parse(requestBody || '{}');
			if (body.phenotypes?.includes('ambiguous phrase')) {
				return sendJson(response, 422, { detail: {
					message: 'Resolve every ambiguous or unmatched phenotype.',
					normalization: [{ input: 'ambiguous phrase', hpo_id: null, match_type: 'ambiguous', candidates: [{ hpo_id: 'HP:0000001', term: 'Term one' }, { hpo_id: 'HP:0000002', term: 'Term two' }] }],
				} });
			}
			return sendJson(response, 200, hpoNormalization);
		}
		if (request.url === '/rare-disease/rank') {
			return sendJson(response, state.available ? 200 : 503, hpoRank);
		}
		if (request.url === '/amr/genome-panel') {
			return sendJson(response, state.genomePanelStatus, state.genomePanelStatus === 200 ? genomePanel : { detail: 'Genome panel failure.' });
		}
		if (request.url === '/amr/predict') {
			return sendJson(response, state.predictStatus, state.predictStatus === 200 ? prediction : { detail: 'Injected inference failure.' });
		}
		return sendJson(response, 404, { detail: 'Not found.' });
	});
	await new Promise((resolve, reject) => {
		mlServer.once('error', reject);
		mlServer.listen(0, '127.0.0.1', resolve);
	});
	mlUrl = `http://127.0.0.1:${mlServer.address().port}`;
	apiProcess = await startApi();
});

after(async () => {
	await stopApi();
	if (mlServer?.listening) await new Promise((resolve) => mlServer.close(resolve));
	await testPool?.end();
	await adminPool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
	await adminPool.end();
});

test('API enforces request contracts and the 1 MiB body limit', async () => {
	const unknownField = await api('/api/amr/predict', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(predictRequest({ patient_id: 'not-accepted' })),
	});
	assert.equal(unknownField.status, 400);
	assert.match((await unknownField.json()).details.join(' '), /Unexpected field: patient_id/);

	const tooManyProducts = await api('/api/amr/predict', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(predictRequest({ products: Array(101).fill('enzyme x') })),
	});
	assert.equal(tooManyProducts.status, 400);

	const oversized = await api('/api/amr/predict', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ payload: 'x'.repeat(1_048_600) }),
	});
	assert.equal(oversized.status, 413);
});

test('successful inference persists exact versions and can be reopened after an API process restart', async () => {
	const response = await api('/api/amr/predict', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(predictRequest()),
	});
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('X-SignalLab-API-Version'), '1.1.0');
	const result = await response.json();
	assert.equal(result.score_semantics, 'Uncalibrated model score; not a probability.');
	assert.equal(result.model_version, modelVersion);
	assert.equal(result.dataset_version, datasetVersion);
	assert.equal(result.feature_vocabulary_version, vocabulary.vocabulary_version);

	let detailResponse = await api(`/api/analyses/${result.analysis_id}`);
	assert.equal(detailResponse.status, 200);
	let detail = await detailResponse.json();
	assert.equal(detail.analysis.status, 'completed');
	assert.equal(detail.analysis.result_data.analysis_id, result.analysis_id);
	assert.equal(detail.analysis.model_version, modelVersion);
	assert.equal(detail.analysis.dataset_version, datasetVersion);

	await restartApi();
	detailResponse = await api(`/api/analyses/${result.analysis_id}`);
	assert.equal(detailResponse.status, 200);
	detail = await detailResponse.json();
	assert.equal(detail.analysis.status, 'completed');
	assert.equal(detail.analysis.result_data.feature_vocabulary_version, vocabulary.vocabulary_version);
});

test('out-of-vocabulary input is rejected without creating an analysis', async () => {
	const beforeCount = await testPool.query('SELECT count(*)::integer AS count FROM analysis_runs');
	const response = await api('/api/amr/predict', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(predictRequest({ organism: 'unknown species', products: ['unseen product'] })),
	});
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /outside the trained model vocabulary/);
	const afterCount = await testPool.query('SELECT count(*)::integer AS count FROM analysis_runs');
	assert.equal(afterCount.rows[0].count, beforeCount.rows[0].count);
});

test('inference failure persists a failed versioned row with no fabricated result', async () => {
	state.predictStatus = 503;
	try {
		const response = await api('/api/amr/predict', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(predictRequest()),
		});
		assert.equal(response.status, 500);
		const list = await (await api('/api/analyses?limit=100')).json();
		const failed = list.analyses.find((analysis) => analysis.status === 'failed');
		assert.ok(failed, 'failed analysis should be visible in history');
		const detail = await (await api(`/api/analyses/${failed.id}`)).json();
		assert.equal(detail.analysis.status, 'failed');
		assert.equal(detail.analysis.model_version, modelVersion);
		assert.equal(detail.analysis.dataset_version, datasetVersion);
		assert.equal(detail.analysis.result_data, null);
		assert.match(detail.analysis.error_message, /returned 503/);
	} finally {
		state.predictStatus = 200;
	}
});

test('unavailable ML service is reported as degraded and does not persist a prediction', async () => {
	state.available = false;
	try {
		const health = await api('/api/health');
		assert.equal(health.status, 503);
		assert.equal((await health.json()).dependencies.amr_model_service, 'unavailable');
		const beforeCount = await testPool.query('SELECT count(*)::integer AS count FROM analysis_runs');
		const response = await api('/api/amr/predict', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(predictRequest()),
		});
		assert.equal(response.status, 503);
		const afterCount = await testPool.query('SELECT count(*)::integer AS count FROM analysis_runs');
		assert.equal(afterCount.rows[0].count, beforeCount.rows[0].count);
	} finally {
		state.available = true;
	}
});

test('early deletion and retention cleanup both cascade to review feedback', async () => {
	const early = await createAnalysis();
	const feedbackResponse = await api(`/api/analyses/${early.analysis_id}/feedback`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ decision: 'accept' }),
	});
	assert.equal(feedbackResponse.status, 201);
	const deleteResponse = await api(`/api/analyses/${early.analysis_id}`, { method: 'DELETE' });
	assert.equal(deleteResponse.status, 204);
	assert.equal((await api(`/api/analyses/${early.analysis_id}`)).status, 404);
	const deletedFeedback = await testPool.query('SELECT count(*)::integer AS count FROM review_feedback WHERE analysis_id = $1', [early.analysis_id]);
	assert.equal(deletedFeedback.rows[0].count, 0);

	const expired = await createAnalysis();
	const expiredFeedback = await api(`/api/analyses/${expired.analysis_id}/feedback`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ decision: 'needs_review' }),
	});
	assert.equal(expiredFeedback.status, 201);
	await testPool.query("UPDATE analysis_runs SET created_at = now() - interval '91 days' WHERE id = $1", [expired.analysis_id]);
	await restartApi();
	assert.equal((await api(`/api/analyses/${expired.analysis_id}`)).status, 404);
	const purgedFeedback = await testPool.query('SELECT count(*)::integer AS count FROM review_feedback WHERE analysis_id = $1', [expired.analysis_id]);
	assert.equal(purgedFeedback.rows[0].count, 0);
});

test('genome catalog lookup and antibiotic panel persist genome provenance', async () => {
	const catalogResponse = await api('/api/amr/genomes?q=klebsiella&limit=5');
	assert.equal(catalogResponse.status, 200);
	assert.equal((await catalogResponse.json()).genomes[0].genome_id, genomePanel.genome_id);

	const response = await api('/api/amr/genome-panel', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ genome_id: genomePanel.genome_id }),
	});
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.equal(result.genome_id, genomePanel.genome_id);
	assert.equal(result.analysis_id.length > 0, true);
	assert.equal(result.genome_catalog_sha256, genomePanel.genome_catalog_sha256);
	assert.equal(result.antibiotic_panel[0].resistance_signal_flagged, true);
	assert.equal(result.antibiotic_panel[0].predicted_phenotype, 'R');
	assert.equal(result.antibiotic_panel[0].pair_evaluation.support_status, 'descriptive_only');
	assert.deepEqual(result.antibiotic_panel[0].pair_evaluation.confidence_intervals_95.sensitivity, [0.58, 0.92]);
	assert.equal(result.predicted_resistant_count, 1);
	assert.equal(result.predicted_susceptible_count, 0);

	const detail = await (await api(`/api/analyses/${result.analysis_id}`)).json();
	assert.equal(detail.analysis.status, 'completed');
	assert.equal(detail.analysis.input_data.genome_id, genomePanel.genome_id);
	assert.equal(detail.analysis.result_data.genome_source_sha256, genomePanel.genome_source_sha256);
});

test('genome panel request requires a BV-BRC genome ID', async () => {
	const response = await api('/api/amr/genome-panel', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ genome_id: 'not-a-genome-id' }),
	});
	assert.equal(response.status, 400);
	assert.match((await response.json()).details.join(' '), /invalid format/);
});

test('rare-disease ranking normalizes exact HPO terms and persists artifact provenance', async () => {
	await testPool.query(
		`INSERT INTO model_versions (version, family, description, metadata)
		 VALUES ('PHENO-OVERLAP-DEMO-01', 'rare_disease', 'Old demo', '{}'::jsonb)
		 ON CONFLICT (version) DO NOTHING`,
	);
	await restartApi();
	const registeredModels = await (await api('/api/models')).json();
	const legacyModel = registeredModels.models.find((model) => model.version === 'PHENO-OVERLAP-DEMO-01');
	assert.equal(legacyModel.metadata.deprecated, true);
	assert.equal(legacyModel.metadata.replaced_by, hpoModelVersion);

	const response = await api('/api/rare-disease/rank', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ phenotypes: 'developmental delay' }),
	});
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.equal(result.model_version, hpoModelVersion);
	assert.equal(result.dataset_version, hpoDatasetVersion);
	assert.equal(result.dataset_sha256, hpoMetadata.dataset_sha256);
	assert.equal(result.evaluation_mode, 'hpo_resnik_relative_ranking');
	assert.match(result.score_semantics, /not a probability/);
	assert.equal(result.normalization[0].hpo_id, 'HP:0001263');

	const detail = await (await api(`/api/analyses/${result.analysis_id}`)).json();
	assert.equal(detail.analysis.status, 'completed');
	assert.equal(detail.analysis.model_version, hpoModelVersion);
	assert.equal(detail.analysis.dataset_version, hpoDatasetVersion);
	assert.deepEqual(detail.analysis.input_data.normalized_hpo_ids, ['HP:0001263']);
	assert.deepEqual(detail.analysis.result_data.artifacts, hpoMetadata.artifacts);
});

test('ambiguous HPO normalization is returned for correction without ranking or persistence', async () => {
	const beforeCount = await testPool.query('SELECT count(*)::integer AS count FROM analysis_runs');
	const response = await api('/api/rare-disease/rank', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ phenotypes: 'ambiguous phrase' }),
	});
	assert.equal(response.status, 422);
	const result = await response.json();
	assert.match(result.error, /Resolve every ambiguous/);
	assert.equal(result.normalization[0].match_type, 'ambiguous');
	assert.equal(result.normalization[0].candidates.length, 2);
	const afterCount = await testPool.query('SELECT count(*)::integer AS count FROM analysis_runs');
	assert.equal(afterCount.rows[0].count, beforeCount.rows[0].count);
});