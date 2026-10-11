export const API_VERSION = '1.1.0';
export const API_VERSION_HEADER = 'X-SignalLab-API-Version';

export const API_ENDPOINTS = Object.freeze({
  health: { method: 'GET', path: '/api/health', responseSchema: 'health', successStatus: 200 },
  amrVocabulary: { method: 'GET', path: '/api/amr/vocabulary', responseSchema: 'amrVocabulary', successStatus: 200 },
  amrGenomes: { method: 'GET', path: '/api/amr/genomes', responseSchema: 'amrGenomeList', successStatus: 200 },
  amrPredict: { method: 'POST', path: '/api/amr/predict', requestSchema: 'amrPredictRequest', responseSchema: 'amrPrediction', successStatus: 200 },
  amrGenomePanel: { method: 'POST', path: '/api/amr/genome-panel', requestSchema: 'amrGenomePanelRequest', responseSchema: 'amrGenomePanel', successStatus: 200 },
  amrSequenceStatus: { method: 'GET', path: '/api/amr/sequence/status', responseSchema: 'amrSequenceStatus', successStatus: 200 },
  amrSequencePreflight: { method: 'POST', path: '/api/amr/sequence/preflight', responseSchema: 'amrSequencePreflight', successStatus: 200 },
  rareDiseaseRank: { method: 'POST', path: '/api/rare-disease/rank', requestSchema: 'rareDiseaseRankRequest', responseSchema: 'rareDiseaseRank', successStatus: 200 },
  analyses: { method: 'GET', path: '/api/analyses', responseSchema: 'analysisList', successStatus: 200 },
  analysisDetail: { method: 'GET', path: '/api/analyses/:id', responseSchema: 'analysisDetail', successStatus: 200 },
  analysisDelete: { method: 'DELETE', path: '/api/analyses/:id', successStatus: 204 },
  analysisFeedback: { method: 'POST', path: '/api/analyses/:id/feedback', requestSchema: 'reviewFeedbackRequest', responseSchema: 'reviewFeedback', successStatus: 201 },
  models: { method: 'GET', path: '/api/models', responseSchema: 'modelList', successStatus: 200 },
  datasets: { method: 'GET', path: '/api/datasets', responseSchema: 'datasetList', successStatus: 200 },
});

export const REQUEST_SCHEMAS = Object.freeze({
  amrPredictRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['organism', 'antibiotic'],
    properties: {
      organism: { type: 'string', minLength: 1, maxLength: 200 },
      antibiotic: { type: 'string', minLength: 1, maxLength: 200 },
      products: {
        type: 'array',
        maxItems: 100,
        items: { type: 'string', maxLength: 300 },
      },
    },
  },
  amrGenomePanelRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['genome_id'],
    properties: {
      genome_id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^\\d+\\.\\d+$' },
    },
  },
  rareDiseaseRankRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['phenotypes'],
    properties: {
      phenotypes: { type: 'string', minLength: 1, maxLength: 8000 },
    },
  },
  reviewFeedbackRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['decision'],
    properties: {
      decision: { type: 'string', enum: ['accept', 'reject', 'needs_review'] },
      notes: { type: 'string', maxLength: 2000 },
    },
  },
});

export const RESPONSE_SCHEMAS = Object.freeze({
  health: {
    type: 'object',
    required: ['service', 'status', 'dependencies'],
    properties: {
      service: { type: 'string' },
      status: { type: 'string', enum: ['ok', 'degraded'] },
      dependencies: {
        type: 'object',
        required: ['database', 'amr_model_service', 'rare_disease_inference'],
        properties: {
          database: { type: 'string' },
          amr_model_service: { type: 'string' },
          rare_disease_inference: { type: 'string' },
        },
      },
    },
  },
  amrPrediction: {
    type: 'object',
    required: [
      'analysis_id', 'prediction', 'resistance_score', 'score_semantics', 'decision_threshold',
      'evidence', 'caveat', 'evaluation', 'evaluation_mode', 'model_version', 'model_sha256',
      'dataset_version', 'dataset_sha256', 'feature_vocabulary_version', 'feature_vocabulary_sha256',
    ],
    properties: {
      analysis_id: { type: 'string' },
      prediction: { type: 'string' },
      resistance_score: { type: 'number' },
      score_semantics: { const: 'Uncalibrated model score; not a probability.' },
      decision_threshold: { type: 'number' },
      evidence: { type: 'array', items: { type: 'string' } },
      caveat: { type: 'string' },
      evaluation: { type: 'object' },
      evaluation_mode: { const: 'trained_baseline_uncalibrated' },
      model_version: { type: 'string' },
      model_sha256: { type: 'string' },
      dataset_version: { type: 'string' },
      dataset_sha256: { type: 'string' },
      feature_vocabulary_version: { type: 'string' },
      feature_vocabulary_sha256: { type: 'string' },
    },
  },
  amrVocabulary: {
    type: 'object',
    required: [
      'vocabulary_version', 'model_version', 'dataset_version', 'source_sha256',
      'source_split', 'source_records', 'sha256', 'organisms', 'antibiotics', 'products',
      'scope_version', 'scope_status', 'scope_organism', 'scope_pairs', 'scope_limitations',
    ],
    properties: {
      vocabulary_version: { type: 'string' },
      model_version: { type: 'string' },
      dataset_version: { type: 'string' },
      source_sha256: { type: 'string' },
      source_split: { const: 'train' },
      source_records: { type: 'number' },
      sha256: { type: 'string' },
      organisms: { type: 'array', items: { type: 'string' } },
      antibiotics: { type: 'array', items: { type: 'string' } },
      products: { type: 'array', items: { type: 'string' } },
      scope_version: { type: 'string' },
      scope_status: { type: 'string' },
      scope_organism: { type: 'string' },
      scope_pairs: { type: 'array', items: { type: 'object' } },
      scope_limitations: { type: 'array', items: { type: 'string' } },
    },
  },
  amrGenomeList: {
    type: 'object',
    required: ['catalog_version', 'catalog_sha256', 'total', 'genomes'],
    properties: {
      catalog_version: { type: 'string' },
      catalog_sha256: { type: 'string' },
      total: { type: 'number' },
      genomes: {
        type: 'array',
        items: {
          type: 'object',
          required: ['genome_id', 'organism', 'detected_product_count'],
          properties: {
            genome_id: { type: 'string' },
            organism: { type: 'string' },
            detected_product_count: { type: 'number' },
          },
        },
      },
    },
  },
  amrSequenceStatus: {
    type: 'object',
    required: ['workflow', 'status', 'caller', 'model', 'requirements'],
    properties: {
      workflow: { const: 'sequence_native' },
      status: { type: 'string', enum: ['blocked_data_required', 'ready_for_prediction'] },
      caller: { type: 'object' },
      model: { type: 'object' },
      requirements: { type: 'array', items: { type: 'string' } },
    },
  },
  amrSequencePreflight: {
    type: 'object',
    required: ['analysis_id', 'workflow', 'status', 'preflight', 'caller', 'model'],
    properties: {
      analysis_id: { type: 'string' },
      workflow: { const: 'sequence_native' },
      status: { enum: ['preflight_complete', 'caller_complete'] },
      preflight: { type: 'object' },
      caller: { type: 'object' },
      model: { type: 'object' },
    },
  },
  amrGenomePanel: {
    type: 'object',
    required: [
      'analysis_id', 'genome_id', 'organism', 'detected_products', 'antibiotic_panel',
      'flagged_count', 'panel_count', 'score_semantics', 'decision_threshold', 'caveat',
      'evaluation', 'model_version', 'model_sha256', 'dataset_version', 'dataset_sha256',
      'feature_vocabulary_version', 'feature_vocabulary_sha256', 'genome_catalog_version',
      'genome_catalog_sha256', 'genome_source_sha256', 'genome_source_snapshot',
    ],
    properties: {
      analysis_id: { type: 'string' },
      genome_id: { type: 'string' },
      organism: { type: 'string' },
      detected_products: { type: 'array', items: { type: 'string' } },
      antibiotic_panel: {
        type: 'array',
        items: {
          type: 'object',
          required: ['antibiotic', 'predicted_phenotype', 'resistance_score', 'resistance_signal_flagged', 'interpretation', 'pair_evaluation'],
          properties: {
            antibiotic: { type: 'string' },
            predicted_phenotype: { type: 'string', enum: ['R', 'S'] },
            resistance_score: { type: 'number' },
            resistance_signal_flagged: { type: 'boolean' },
            interpretation: { type: 'string' },
            pair_evaluation: {
              type: 'object',
              required: ['records', 'resistant_records', 'susceptible_records', 'support_status', 'auroc', 'auprc', 'brier_score', 'expected_calibration_error', 'sensitivity', 'specificity', 'confidence_intervals_95'],
              properties: {
                records: { type: 'number' },
                resistant_records: { type: 'number' },
                susceptible_records: { type: 'number' },
                support_status: { type: 'string', enum: ['not_assessed', 'insufficient_support', 'descriptive_only'] },
                auroc: { type: ['number', 'null'] },
                auprc: { type: ['number', 'null'] },
                brier_score: { type: ['number', 'null'] },
                expected_calibration_error: { type: ['number', 'null'] },
                sensitivity: { type: ['number', 'null'] },
                specificity: { type: ['number', 'null'] },
                confidence_intervals_95: {
                  type: 'object',
                  required: ['auroc', 'auprc', 'sensitivity', 'specificity', 'brier_score', 'expected_calibration_error'],
                  properties: {
                    auroc: { type: ['array', 'null'], items: { type: 'number' } },
                    auprc: { type: ['array', 'null'], items: { type: 'number' } },
                    sensitivity: { type: ['array', 'null'], items: { type: 'number' } },
                    specificity: { type: ['array', 'null'], items: { type: 'number' } },
                    brier_score: { type: ['array', 'null'], items: { type: 'number' } },
                    expected_calibration_error: { type: ['array', 'null'], items: { type: 'number' } },
                  },
                },
              },
            },
          },
        },
      },
      flagged_count: { type: 'number' },
      predicted_resistant_count: { type: 'number' },
      predicted_susceptible_count: { type: 'number' },
      panel_count: { type: 'number' },
      score_semantics: { const: 'Uncalibrated model score; not a probability.' },
      decision_threshold: { type: 'number' },
      caveat: { type: 'string' },
      evaluation: { type: 'object' },
      model_version: { type: 'string' },
      model_sha256: { type: 'string' },
      dataset_version: { type: 'string' },
      dataset_sha256: { type: 'string' },
      feature_vocabulary_version: { type: 'string' },
      feature_vocabulary_sha256: { type: 'string' },
      genome_catalog_version: { type: 'string' },
      genome_catalog_sha256: { type: 'string' },
      genome_source_sha256: { type: 'string' },
      genome_source_snapshot: { type: 'object' },
    },
  },
  apiError: {
    type: 'object',
    required: ['error'],
    properties: {
      error: { type: 'string' },
      details: { type: 'array', items: { type: 'string' } },
    },
  },
  rareDiseaseRank: {
    type: 'object',
    required: ['analysis_id', 'input_hpo_ids', 'normalization', 'candidates', 'method', 'score_semantics', 'caveat', 'evaluation_mode', 'model_version', 'dataset_version', 'dataset_sha256', 'artifacts'],
    properties: {
      analysis_id: { type: 'string' },
      input_hpo_ids: { type: 'array', items: { type: 'string' } },
      normalization: { type: 'array', items: { type: 'object' } },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          required: ['disease_id', 'disease_name', 'score', 'supporting_terms', 'contradiction_score', 'unreported_profile_terms', 'unreported_profile_term_count'],
          properties: {
            disease_id: { type: 'string' },
            disease_name: { type: 'string' },
            score: { type: 'number' },
            supporting_terms: { type: 'array', items: { type: 'object' } },
            contradiction_score: { type: 'number' },
            unreported_profile_terms: { type: 'array', items: { type: 'object' } },
            unreported_profile_term_count: { type: 'number' },
          },
        },
      },
      method: { type: 'string' },
      score_semantics: { const: 'Relative ranking score; not a probability or clinical likelihood.' },
      caveat: { type: 'string' },
      evaluation_mode: { const: 'hpo_resnik_relative_ranking' },
      model_version: { type: 'string' },
      dataset_version: { type: 'string' },
      dataset_sha256: { type: 'string' },
      artifacts: { type: 'object' },
    },
  },
  analysisList: {
    type: 'object',
    required: ['analyses'],
    properties: {
      analyses: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'workflow', 'status', 'created_at'],
          properties: {
            id: { type: 'string' },
            workflow: { type: 'string', enum: ['amr', 'rare_disease'] },
            status: { type: 'string', enum: ['running', 'completed', 'failed'] },
            model_version: { type: ['string', 'null'] },
            dataset_version: { type: ['string', 'null'] },
            created_at: { type: 'string' },
            completed_at: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
  analysisDetail: {
    type: 'object',
    required: ['analysis', 'feedback'],
    properties: {
      analysis: {
        type: 'object',
        required: ['id', 'workflow', 'status', 'input_data', 'result_data', 'model_version', 'dataset_version', 'created_at'],
        properties: {
          id: { type: 'string' },
          workflow: { type: 'string', enum: ['amr', 'rare_disease'] },
          status: { type: 'string', enum: ['running', 'completed', 'failed'] },
          input_data: { type: 'object' },
          result_data: { type: ['object', 'null'] },
          error_message: { type: ['string', 'null'] },
          model_version: { type: ['string', 'null'] },
          dataset_version: { type: ['string', 'null'] },
          created_at: { type: 'string' },
          completed_at: { type: ['string', 'null'] },
        },
      },
      feedback: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'decision', 'notes', 'created_at'],
          properties: {
            id: { type: 'string' },
            decision: { type: 'string', enum: ['accept', 'reject', 'needs_review'] },
            notes: { type: 'string' },
            created_at: { type: 'string' },
          },
        },
      },
    },
  },
  reviewFeedback: {
    type: 'object',
    required: ['feedback'],
    properties: {
      feedback: {
        type: 'object',
        required: ['id', 'analysis_id', 'decision', 'notes', 'created_at'],
        properties: {
          id: { type: 'string' },
          analysis_id: { type: 'string' },
          decision: { type: 'string', enum: ['accept', 'reject', 'needs_review'] },
          notes: { type: 'string' },
          created_at: { type: 'string' },
        },
      },
    },
  },
  modelList: {
    type: 'object',
    required: ['models'],
    properties: {
      models: {
        type: 'array',
        items: {
          type: 'object',
          required: ['version', 'family', 'description', 'metadata', 'registered_at'],
          properties: {
            version: { type: 'string' },
            family: { type: 'string' },
            description: { type: 'string' },
            metadata: { type: 'object' },
            registered_at: { type: 'string' },
          },
        },
      },
    },
  },
  datasetList: {
    type: 'object',
    required: ['datasets'],
    properties: {
      datasets: {
        type: 'array',
        items: {
          type: 'object',
          required: ['version', 'source', 'sha256', 'metadata', 'registered_at'],
          properties: {
            version: { type: 'string' },
            source: { type: 'string' },
            sha256: { type: ['string', 'null'] },
            metadata: { type: 'object' },
            registered_at: { type: 'string' },
          },
        },
      },
    },
  },
});

export const API_CONTRACT = Object.freeze({
  version: API_VERSION,
  versionHeader: API_VERSION_HEADER,
  endpoints: API_ENDPOINTS,
  requests: REQUEST_SCHEMAS,
  responses: RESPONSE_SCHEMAS,
  storagePolicy: Object.freeze({
    directIdentifiersAccepted: false,
    analysisRetentionDaysDefault: 90,
    maxRequestBytes: 1_048_576,
  }),
});

export const MODEL_VERSIONS = Object.freeze({
  amr: 'amr-sgd-feature-baseline-1',
  rareDisease: 'hpo-resnik-baseline-1',
});

export function validateRequest(schemaName, value) {
  const schema = REQUEST_SCHEMAS[schemaName];
  if (!schema) throw new Error(`Unknown request schema: ${schemaName}`);

  const errors = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [`Request body must be a JSON object.`];
  }

  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema.properties, key) && schema.additionalProperties === false) {
      errors.push(`Unexpected field: ${key}.`);
    }
  }

  for (const key of schema.required) {
    if (!Object.hasOwn(value, key)) errors.push(`${key} is required.`);
  }

  for (const [key, rule] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    if (rule.type === 'string') {
      if (typeof item !== 'string') {
        errors.push(`${key} must be a string.`);
        continue;
      }
      if (rule.minLength && item.trim().length < rule.minLength) errors.push(`${key} must not be empty.`);
      if (rule.maxLength && item.length > rule.maxLength) errors.push(`${key} must be ${rule.maxLength} characters or fewer.`);
      if (rule.pattern && !new RegExp(rule.pattern).test(item)) errors.push(`${key} has an invalid format.`);
      if (rule.enum && !rule.enum.includes(item)) errors.push(`${key} must be one of: ${rule.enum.join(', ')}.`);
    } else if (rule.type === 'array') {
      if (!Array.isArray(item)) {
        errors.push(`${key} must be an array.`);
        continue;
      }
      if (item.length > rule.maxItems) errors.push(`${key} must contain at most ${rule.maxItems} items.`);
      item.forEach((entry, index) => {
        if (typeof entry !== rule.items.type) errors.push(`${key}[${index}] must be a string.`);
        else if (rule.items.maxLength && entry.length > rule.items.maxLength) {
          errors.push(`${key}[${index}] must be ${rule.items.maxLength} characters or fewer.`);
        }
      });
    }
  }

  return errors;
}

export function validateResponse(schemaName, value) {
  const schema = RESPONSE_SCHEMAS[schemaName];
  if (!schema) throw new Error(`Unknown response schema: ${schemaName}`);
  return validateValue(schema, value, 'response');
}

function validateValue(schema, value, path) {
  const errors = [];
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && !allowedTypes.includes(actualType)) return [`${path} must be ${allowedTypes.join(' or ')}.`];
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return [`${path} must equal ${JSON.stringify(schema.const)}.`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of: ${schema.enum.join(', ')}.`);

  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required.`);
    }
    for (const [key, rule] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) errors.push(...validateValue(rule, value[key], `${path}.${key}`));
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateValue(schema.items, item, `${path}[${index}]`)));
  }
  if (schema.type === 'string' && schema.minLength && value.trim().length < schema.minLength) {
    errors.push(`${path} must not be empty.`);
  }
  if (schema.type === 'number' && !Number.isFinite(value)) errors.push(`${path} must be a finite number.`);
  return errors;
}
