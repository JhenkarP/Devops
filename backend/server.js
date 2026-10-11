import cors from 'cors';
import express from 'express';
import { fileURLToPath } from 'node:url';
import {
	API_ENDPOINTS,
	API_VERSION,
	API_VERSION_HEADER,
	validateRequest,
} from './api-contract.js';
import {
	ANALYSIS_RETENTION_DAYS,
	completeAnalysis,
	createAnalysis,
	failAnalysis,
	AMR_DATASET_VERSION,
	AMR_MODEL_VERSION,
	HPO_MODEL_VERSION,
	migrateDatabase,
	purgeExpiredAnalyses,
	pool,
	registerModelVersions,
} from './database.js';
import { getAmrScope, isInAmrScope } from './amr-scope.js';
import { preflightFasta } from './sequence-preflight.js';
import { callAmrfinder } from './sequence-caller.js';

const app = express();
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:8000';
let hpoMetadata;

app.use(cors({ exposedHeaders: [API_VERSION_HEADER] }));
app.use((_req, res, next) => {
	res.set(API_VERSION_HEADER, API_VERSION);
	next();
});
app.use(express.json({ limit: '1mb' }));

function requiredText(value, field, maxLength = 2000) {
	if (typeof value !== 'string' || !value.trim()) {
		const error = new Error(`${field} is required.`);
		error.status = 400;
		throw error;
	}
	if (value.length > maxLength) {
		const error = new Error(`${field} must be ${maxLength} characters or fewer.`);
		error.status = 400;
		throw error;
	}
	return value.trim();
}

function normalizeCategory(value) {
	return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function fetchAmrVocabulary(query) {
	const url = new URL(`${ML_SERVICE_URL}/amr/vocabulary`);
	if (query) url.searchParams.set('q', query);
	const response = await fetch(url);
	if (!response.ok) {		const error = new Error('AMR feature vocabulary is unavailable.');
		error.status = 503;
		throw error;
	}
	const vocabulary = await response.json();
	if (vocabulary.model_version !== AMR_MODEL_VERSION || vocabulary.dataset_version !== AMR_DATASET_VERSION) {
		const error = new Error('AMR feature vocabulary version does not match the registered model and dataset.');
		error.status = 503;
		throw error;
	}
	return vocabulary;
}

async function fetchHpoMetadata() {
	const response = await fetch(`${ML_SERVICE_URL}/rare-disease/metadata`);
	if (!response.ok) {
		const error = new Error('HPO model and dataset metadata are unavailable.');
		error.status = 503;
		throw error;
	}
	const metadata = await response.json();
	if (metadata.model_version !== HPO_MODEL_VERSION || !/^[a-f0-9]{64}$/.test(metadata.dataset_sha256)
		|| metadata.dataset_version !== `hpo-knowledge-${metadata.dataset_sha256.slice(0, 16)}`) {
		const error = new Error('HPO model or dataset provenance is invalid.');
		error.status = 503;
		throw error;
	}
	return metadata;
}

async function fetchAmrGenomes(query, limit = 25) {
	const url = new URL(`${ML_SERVICE_URL}/amr/genomes`);
	if (query) url.searchParams.set('q', query);
	url.searchParams.set('limit', String(limit));
	const response = await fetch(url);
	if (!response.ok) {
		const error = new Error('AMR genome catalog is unavailable.');
		error.status = 503;
		throw error;
	}
	const catalog = await response.json();
	if (!catalog.catalog_version || !/^[a-f0-9]{64}$/.test(catalog.catalog_sha256)) {
		const error = new Error('AMR genome catalog provenance is invalid.');
		error.status = 503;
		throw error;
	}
	return catalog;
}

async function runAnalysis(res, workflow, modelVersion, inputData, calculate, datasetVersion = null) {
	let analysisId;
	try {
		analysisId = await createAnalysis({ workflow, inputData, modelVersion, datasetVersion });
		const result = { ...await calculate(), analysis_id: analysisId };
		await completeAnalysis(analysisId, result);
		res.json(result);
	} catch (error) {
		if (analysisId) await failAnalysis(analysisId, error.message).catch(() => {});
		throw error;
	}
}

app.get(API_ENDPOINTS.health.path, async (_req, res) => {
	let database = 'ok';
	let mlService = 'ok';
	let rareDiseaseInference = 'ok';
	try {
		await pool.query('SELECT 1');
	} catch {
		database = 'unavailable';
	}
	try {
		const response = await fetch(`${ML_SERVICE_URL}/health`);
		if (!response.ok) mlService = 'unavailable';
	} catch {
		mlService = 'unavailable';
	}
	try {
		hpoMetadata = await fetchHpoMetadata();
	} catch {
		rareDiseaseInference = 'unavailable';
	}
	const status = database === 'ok' && mlService === 'ok' && rareDiseaseInference === 'ok' ? 'ok' : 'degraded';
	res.status(status === 'ok' ? 200 : 503).json({
		service: 'signallab-api',
		status,
		dependencies: { database, amr_model_service: mlService, rare_disease_inference: rareDiseaseInference },
	});
});

app.get(API_ENDPOINTS.amrVocabulary.path, async (req, res, next) => {
	try {
		const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
		const vocabulary = await fetchAmrVocabulary(query);
		res.json(vocabulary);
	} catch (error) {
		next(error);
	}
});

app.get(API_ENDPOINTS.amrGenomes.path, async (req, res, next) => {
	try {
		const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
		const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 50);
		res.json(await fetchAmrGenomes(query, limit));
	} catch (error) {
		next(error);
	}
});

app.get(API_ENDPOINTS.amrSequenceStatus.path, (_req, res) => {
	res.json({
		workflow: 'sequence_native',
		status: 'blocked_data_required',
		caller: {
			name: 'AMRFinderPlus',
			version: '4.2.7',
			database_version: '2026-08-07.1',
			image_digest: 'sha256:52dc48754305adfed9100a51be41ad0438e42aac02f0f4c58c46c23d9ea3e74e',
			status: 'available_in_pinned_docker_runner',
		},
		model: {
			name: 'sequence_determinant_amr_sgd',
			status: 'not_trained',
			calibration_status: 'not_calibrated',
		},
		requirements: [
			'Linked genome FASTA and measured laboratory AST records are required.',
			'Each record must include isolate ID, physical laboratory ID, AST method/standard, and caller provenance.',
			'An antibiotic-specific model must pass genome-disjoint train, validation, and test gates before prediction.',
		],
	});
});

app.post(API_ENDPOINTS.amrSequencePreflight.path, express.raw({ type: ['application/octet-stream', 'text/plain'], limit: '25mb' }), async (req, res, next) => {
	try {
		if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
			const error = new Error('Upload a non-empty FASTA file.');
			error.status = 400;
			throw error;
		}
		const filename = requiredText(req.get('X-SignalLab-Filename'), 'X-SignalLab-Filename', 255);
		if (!/\.(?:fa|fna|fasta)(?:\.gz)?$/i.test(filename)) {
			const error = new Error('FASTA upload must end in .fa, .fna, .fasta, or a gzip variant.');
			error.status = 400;
			throw error;
		}
		let preflight;
		try {
			preflight = preflightFasta(req.body, filename);
		} catch (error) {
			error.status = 400;
			throw error;
		}
		await runAnalysis(res, 'sequence_native', null, {
			filename,
			input_sha256: preflight.input_sha256,
			preflight_report_version: preflight.report_version,
		}, async () => ({
			workflow: 'sequence_native',
			status: process.env.SEQUENCE_CALLER_ENABLED === 'true' && preflight.assembly_quality_status === 'passed' ? 'caller_complete' : 'preflight_complete',
			preflight: { ...preflight, taxonomy_status: 'not_verified', taxonomy_limitation: 'FASTA preflight does not establish organism identity.' },
			caller: process.env.SEQUENCE_CALLER_ENABLED === 'true' && preflight.assembly_quality_status === 'passed'
				? { status: 'completed', tool: 'AMRFinderPlus', version: '4.2.7', database_version: '2026-08-07.1', features: await callAmrfinder({ bytes: req.body, filename, preflight }) }
				: { status: 'blocked_quality_gate', reason: process.env.SEQUENCE_CALLER_ENABLED === 'true' ? 'Assembly-quality thresholds did not pass.' : 'Caller execution is disabled in this environment.' },
			model: { status: 'not_called', reason: 'Sequence-native model is not trained.' },
		}));
	} catch (error) {
		next(error);
	}
});

app.post(API_ENDPOINTS.amrPredict.path, async (req, res, next) => {
	try {
		const validationErrors = validateRequest('amrPredictRequest', req.body);
		if (validationErrors.length) return res.status(400).json({ error: 'Request does not match API v1.', details: validationErrors });
		const organism = requiredText(req.body.organism, 'organism', 200);
		const antibiotic = requiredText(req.body.antibiotic, 'antibiotic', 200);
		const products = [...new Set((req.body.products || []).map((product) => product.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean))];
		const vocabulary = await fetchAmrVocabulary();
		const errors = [];
		if (!vocabulary.organisms.includes(normalizeCategory(organism))) errors.push(`Unsupported organism: ${organism}. Select a value from the trained model vocabulary.`);
		if (!vocabulary.antibiotics.includes(normalizeCategory(antibiotic))) errors.push(`Unsupported antibiotic: ${antibiotic}. Select a value from the trained model vocabulary.`);
		if (!isInAmrScope(normalizeCategory(organism), normalizeCategory(antibiotic))) errors.push(`This organism-antibiotic pair is outside the initial AMR scope. Supported scope: ${getAmrScope().organism} with ${getAmrScope().pairs.map((pair) => pair.antibiotic).join(', ')}.`);
		const unsupportedProducts = products.filter((product) => !vocabulary.products.includes(product));
		if (unsupportedProducts.length) errors.push(`Unsupported resistance product(s): ${unsupportedProducts.join(', ')}. Add only values from the trained model vocabulary.`);
		if (errors.length) return res.status(400).json({ error: 'Input contains values outside the trained model vocabulary; no prediction was made.', details: errors });
		const inputData = { organism, antibiotic, products };
		await runAnalysis(res, 'amr', AMR_MODEL_VERSION, inputData, async () => {
			const response = await fetch(`${ML_SERVICE_URL}/amr/predict`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(inputData),
			});
			if (!response.ok) throw new Error(`AMR model service returned ${response.status}.`);
			const result = await response.json();
			if (result.model_version !== AMR_MODEL_VERSION || result.dataset_version !== AMR_DATASET_VERSION) {
				throw new Error('AMR model service returned an unregistered model or dataset version.');
			}
			return result;
		}, AMR_DATASET_VERSION);
	} catch (error) {
		next(error);
	}
});

app.post(API_ENDPOINTS.amrGenomePanel.path, async (req, res, next) => {
	try {
		const validationErrors = validateRequest('amrGenomePanelRequest', req.body);
		if (validationErrors.length) return res.status(400).json({ error: 'Request does not match API v1.', details: validationErrors });
		const genomeId = requiredText(req.body.genome_id, 'genome_id', 100);
		const inputData = { genome_id: genomeId };
		await runAnalysis(res, 'amr', AMR_MODEL_VERSION, inputData, async () => {
			const response = await fetch(`${ML_SERVICE_URL}/amr/genome-panel`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(inputData),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				const message = typeof body.detail === 'object' ? body.detail.message : body.detail;
				const error = new Error(message || `AMR model service returned ${response.status}.`);
				error.status = response.status >= 500 ? 500 : response.status;
				throw error;
			}
			const result = await response.json();
			if (result.model_version !== AMR_MODEL_VERSION || result.dataset_version !== AMR_DATASET_VERSION) {
				throw new Error('AMR model service returned an unregistered model or dataset version.');
			}
			return result;
		}, AMR_DATASET_VERSION);
	} catch (error) {
		next(error);
	}
});

app.post(API_ENDPOINTS.rareDiseaseRank.path, async (req, res, next) => {
	try {
		const validationErrors = validateRequest('rareDiseaseRankRequest', req.body);
		if (validationErrors.length) return res.status(400).json({ error: 'Request does not match API v1.', details: validationErrors });
		const phenotypes = requiredText(req.body.phenotypes, 'phenotypes', 8000)
			.split(/[,;\n]+/).map((term) => term.trim()).filter(Boolean);
		if (!phenotypes.length || phenotypes.length > 100) {
			return res.status(400).json({ error: 'Enter between 1 and 100 phenotype terms.' });
		}
		const resourceMetadata = hpoMetadata || await fetchHpoMetadata();
		let normalizationResponse;
		try {
			normalizationResponse = await fetch(`${ML_SERVICE_URL}/rare-disease/normalize`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ phenotypes }),
			});
		} catch {
			const error = new Error('HPO normalization service is unavailable.');
			error.status = 503;
			throw error;
		}
		if (!normalizationResponse.ok) {
			const body = await normalizationResponse.json().catch(() => ({}));
			const detail = body.detail || {};
			if (normalizationResponse.status === 422 && Array.isArray(detail.normalization)) {
				return res.status(422).json({ error: detail.message, normalization: detail.normalization });
			}
			const error = new Error(typeof detail === 'string' ? detail : 'HPO normalization failed.');
			error.status = normalizationResponse.status >= 500 ? 503 : normalizationResponse.status;
			throw error;
		}
		const normalization = await normalizationResponse.json();
		if (normalization.model_version !== HPO_MODEL_VERSION || normalization.dataset_version !== resourceMetadata.dataset_version
			|| normalization.dataset_sha256 !== resourceMetadata.dataset_sha256) {
			const error = new Error('HPO normalization returned an unregistered resource version.');
			error.status = 503;
			throw error;
		}
		const inputData = { phenotypes, normalized_hpo_ids: normalization.hpo_ids };
		await runAnalysis(res, 'rare_disease', HPO_MODEL_VERSION, inputData, async () => {
			const response = await fetch(`${ML_SERVICE_URL}/rare-disease/rank`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ hpo_ids: normalization.hpo_ids, top_k: 10 }),
			});
			if (!response.ok) throw new Error(`HPO ranker returned ${response.status}.`);
			const result = await response.json();
			if (result.model_version !== HPO_MODEL_VERSION || result.dataset_version !== resourceMetadata.dataset_version
				|| result.dataset_sha256 !== resourceMetadata.dataset_sha256) {
				throw new Error('HPO ranker returned an unregistered model or dataset version.');
			}
			return { ...result, normalization: normalization.normalization };
		}, resourceMetadata.dataset_version);
	} catch (error) {
		next(error);
	}
});

app.get(API_ENDPOINTS.analyses.path, async (req, res, next) => {
	try {
		const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 100);
		const result = await pool.query(
			`SELECT id, workflow, status, model_version, dataset_version, created_at, completed_at
			 FROM analysis_runs ORDER BY created_at DESC LIMIT $1`,
			[limit],
		);
		res.json({ analyses: result.rows });
	} catch (error) {
		next(error);
	}
});

app.get(API_ENDPOINTS.analysisDetail.path, async (req, res, next) => {
	try {
		const result = await pool.query('SELECT * FROM analysis_runs WHERE id = $1', [req.params.id]);
		if (!result.rowCount) return res.status(404).json({ error: 'Analysis not found.' });
		const feedback = await pool.query(
			'SELECT id, decision, notes, created_at FROM review_feedback WHERE analysis_id = $1 ORDER BY created_at DESC',
			[req.params.id],
		);
		res.json({ analysis: result.rows[0], feedback: feedback.rows });
	} catch (error) {
		next(error);
	}
});

app.delete(API_ENDPOINTS.analysisDelete.path, async (req, res, next) => {
	try {
		const result = await pool.query('DELETE FROM analysis_runs WHERE id = $1 RETURNING id', [req.params.id]);
		if (!result.rowCount) return res.status(404).json({ error: 'Analysis not found.' });
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

app.post(API_ENDPOINTS.analysisFeedback.path, async (req, res, next) => {
	try {
		const validationErrors = validateRequest('reviewFeedbackRequest', req.body);
		if (validationErrors.length) return res.status(400).json({ error: 'Request does not match API v1.', details: validationErrors });
		const { decision } = req.body;
		const notes = typeof req.body.notes === 'string' ? req.body.notes.slice(0, 2000) : '';
		const result = await pool.query(
			`INSERT INTO review_feedback (analysis_id, decision, notes)
			 VALUES ($1, $2, $3) RETURNING id, analysis_id, decision, notes, created_at`,
			[req.params.id, decision, notes],
		);
		res.status(201).json({ feedback: result.rows[0] });
	} catch (error) {
		next(error);
	}
});

app.get(API_ENDPOINTS.models.path, async (_req, res, next) => {
	try {
		const result = await pool.query('SELECT version, family, description, metadata, registered_at FROM model_versions ORDER BY family, version');
		res.json({ models: result.rows });
	} catch (error) {
		next(error);
	}
});

app.get(API_ENDPOINTS.datasets.path, async (_req, res, next) => {
	try {
		const result = await pool.query('SELECT version, source, sha256, metadata, registered_at FROM dataset_versions ORDER BY version');
		res.json({ datasets: result.rows });
	} catch (error) {
		next(error);
	}
});

app.use((error, _req, res, _next) => {
	const status = Number.isInteger(error.status) ? error.status : 500;
	if (status >= 500) console.error('SignalLab API request failed:', error.message);
	res.status(status).json({ error: status >= 500 ? 'The request could not be completed.' : error.message });
});

export async function startServer() {
	await migrateDatabase();
	hpoMetadata = await fetchHpoMetadata();
	await registerModelVersions(hpoMetadata);
	await purgeExpiredAnalyses(ANALYSIS_RETENTION_DAYS);
	const retentionTimer = setInterval(() => {
		purgeExpiredAnalyses(ANALYSIS_RETENTION_DAYS).catch((error) => {
			console.error('Analysis retention cleanup failed:', error.message);
		});
	}, 24 * 60 * 60 * 1000);
	retentionTimer.unref();
	const port = Number.parseInt(process.env.API_PORT || '8787', 10);
	const host = process.env.API_HOST || '127.0.0.1';
	return app.listen(port, host, () => console.log(`SignalLab API listening on http://${host}:${port}`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	startServer().catch((error) => {
		console.error('SignalLab API startup failed:', error.message);
		process.exitCode = 1;
	});
}
