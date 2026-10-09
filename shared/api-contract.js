export const API_CONTRACT = Object.freeze({
  health: { method: 'GET', path: '/api/health' },
  amrPredict: { method: 'POST', path: '/api/amr/predict' },
  rareDiseaseRank: { method: 'POST', path: '/api/rare-disease/rank' }
});

export const MODEL_VERSIONS = Object.freeze({
  amr: 'AMR-BASELINE-01',
  rareDisease: 'PHENO-BASELINE-01'
});
