# SignalLab Implementation Plan

## Product Goal

Build SignalLab, a research decision-support platform with:

1. Antibiotic-resistance phenotype prediction.
2. Rare-disease differential ranking.
3. Evidence explanations.
4. Dataset provenance.
5. Model and experiment version tracking.
6. Human review and feedback.
7. Full web deployment.

The product is research software. It is not a clinical diagnostic system and must not prescribe treatment.

## Current Status

- React/Vite product shell created.
- AMR workflow UI created.
- Rare-disease workflow UI created.
- Express API created.
- FastAPI ML-service contract created.
- HPO ontology downloaded into `data/hp.json`.
- NCBI AMRFinder reference catalog downloaded into `data/amrfinder_reference_genes.tsv`.
- Dataset provenance manifest with checksums created at `data/manifest.json`.
- Frontend production build passes.
- Backend dependencies installed from the `backend` directory.

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite |
| Styling | Custom CSS |
| API | Node.js + Express |
| ML service | Python + FastAPI + PyTorch |
| Database | PostgreSQL |
| ORM | Prisma |
| Validation | Zod and Pydantic |
| Background jobs | Python scripts initially, Celery later |
| Dataset storage | Local `data/`, then S3-compatible object storage |
| Authentication | Auth.js or JWT |
| Local deployment | Docker Compose |
| Production deployment | Docker and managed hosting |
| Frontend tests | Vitest and Playwright |
| Python tests | Pytest |
| Monitoring | Structured logs and model-run metadata |

## Phase 1: Project Foundation

- [x] Remove the old BrandProof application folders.
- [x] Create frontend, backend, ML-service, data, and scripts directories.
- [x] Configure frontend and API run commands.
- [x] Add environment variable templates.
- [x] Add Docker Compose.
- [x] Add shared API contract definitions.
- [x] Add contract and build validation commands.
- [x] Add health checks for every service.

**Deliverable:** Frontend, backend, and contract checks pass with documented commands. Docker Compose has been built and all four local services have been validated as healthy.

## Phase 2: Dataset Acquisition

### AMR datasets

Download and document:

- NCBI AMRFinderPlus reference catalog.
- BV-BRC genome metadata.
- BV-BRC antimicrobial susceptibility phenotype records where available.
- NCBI pathogen resistance metadata.
- CARD or ResFinder reference annotations.

Required AMR fields:

- Organism.
- Antibiotic.
- Resistant, susceptible, or intermediate label.
- Genome identifier.
- Resistance genes.
- Mutations.
- Collection year.
- Geographic or laboratory metadata.
- Susceptibility-testing method.

### Rare-disease resources

Download and document:

- Human Phenotype Ontology.
- HPO disease annotations.
- MONDO disease identifiers.
- Monarch disease-gene-phenotype associations.
- Orphadata resources where licensing permits.
- Public Phenopacket examples and benchmark cases.

Important limitation: HPO and Monarch are knowledge resources, not large patient cohorts. Real patient-level diagnostic data may require controlled access.

**Deliverable:** `data/manifest.json` records source, license, timestamp, version, and download status.

Phase 2 progress:

- [x] HPO ontology downloaded.
- [x] NCBI AMRFinder reference catalog downloaded.
- [x] Checksums and transport details recorded in `data/manifest.json`.
- [x] Docker Desktop installed and Compose runtime validated.
- [x] Bounded phenotype-labelled AMR susceptibility starter export selected and downloaded.

The downloaded BV-BRC AMR export is a bounded 10,000-record starter cohort, not the full BV-BRC catalog. Phase 3 processing has normalized and deduplicated it, joined genome metadata, extracted resistance-associated features, and created split assignments. The current export does not include explicit mutations or genome sequences.

## Phase 3: Data Processing

### AMR processing

- [x] Normalize organism names.
- [x] Normalize antibiotic names.
- [x] Map resistance labels to a consistent schema.
- [x] Remove duplicate isolate/antibiotic/testing records.
- [x] Separate labels by testing method.
- [x] Detect conflicting labels.
- [x] Encode source-provided resistance genes and mutations, with missing links flagged.
- [x] Create genome-derived resistance feature calls from linked BV-BRC genome records.
- [ ] Create genome-derived mutation features from linked isolate sequences.
- [x] Split by collection time where BV-BRC metadata provides a year; records without a year remain unassigned.
- [x] Create laboratory and geography group split assignments where metadata exists.

### Phase 3B: Mutation-data pilot

The current BV-BRC AMR export does not contain isolate sequences, VCF files, or explicit mutation calls. This pilot adds a sequence-backed mutation layer without blocking the gene-feature baseline:

- [x] Generate AMR-linked candidates and resolve BV-BRC genome IDs to assembly accessions (110 candidates for a 100-sequence target).
- [x] Download 100 NCBI assembly archives and record URLs and SHA-256 checksums.
- [ ] Extract and verify 100 usable FASTA assemblies; current result is 99/100 because `GCA_002970785.1` returns 404 from NCBI.
- [ ] Run AMRFinderPlus and PointFinder where the organism is supported.
- [ ] Link verified mutation calls to genome IDs, antibiotics, and observed phenotypes.
- [ ] Validate a representative sample and record coverage or missing-sequence limitations.
- [ ] Expand mutation extraction to the eligible cohort after the pilot is validated.

Phase 3A gene and resistance-feature processing is complete for the 10,000-record cohort. The verified report contains 10,000 source and normalized records, 9,999 deduplicated records, 9,652 metadata matches, and 723,827 resistance feature calls. Mutation analysis has not started. The processing report warning text must be refreshed to reflect the extracted feature calls accurately.

### Rare-disease processing

- [x] Normalize patient free-text symptoms into HPO terms with the reusable `data:normalize-phenotypes` command.
- [x] Map HPO synonyms and ancestor terms; unmatched patient inputs remain reviewable.
- [x] Remove overly generic phenotype terms from disease profiles.
- [x] Track positive and absent findings; unknown remains available for future patient-input handling.
- [x] Build disease-phenotype graph nodes and `is_a` edges.
- [x] Preserve evidence source and publication provenance.
- [x] Create deterministic missing and noisy phenotype sample variants for robustness testing.

**Deliverable:** Reproducible preprocessing script at `scripts/process-datasets.mjs`, generated sample artifacts under `data/processed/`, and `processing_report.json` with counts and warnings.

## Phase 4: Baseline Models

Status: Not started. Build and evaluate the gene/resistance-feature-only baseline first. Add mutation features only after the Phase 3B pilot produces validated calls.

### AMR baseline

- [ ] Build AMRFinderPlus marker lookup using available resistance features.
- [ ] Train and evaluate a gene/resistance-feature-only logistic regression or gradient-boosting baseline.
- [ ] Compare a gene-plus-mutation model if the sequence-backed pilot succeeds.

### Rare-disease baseline

- [ ] Implement HPO semantic-similarity ranking.
### AMR research model

Implement and compare:

- Gene and mutation embeddings.
- Explanations of influential genes or variants.

Research question:

> Can a model predict antibiotic susceptibility from genomic and metadata features while remaining calibrated on unseen laboratories or time periods?
- Missing and noisy phenotype simulation.
- Temporal phenotype updates.
- Evidence provenance weighting.
- Confidence calibration.

Research question:

> How robustly can phenotype-based disease ranking operate when clinical phenotypes are incomplete, noisy, or entered using inconsistent terminology?

## Phase 6: Backend and Database

Create these main tables:

- `users`
- `analysis_runs`
- `amr_inputs`
- `amr_predictions`
- `rare_disease_inputs`
- `rare_disease_candidates`
- `evidence_items`
- `model_versions`
- `dataset_versions`
- `review_feedback`

API routes:

```text
GET  /api/health
POST /api/amr/predict
POST /api/rare-disease/rank
POST /api/analyses
GET  /api/analyses/:id
POST /api/analyses/:id/feedback
GET  /api/models
GET  /api/datasets
```

## Phase 7: Frontend Product

Build these screens:

1. Workspace dashboard.
2. AMR prediction form.
3. Rare-disease differential form.
4. Evidence and explanation panel.
5. Analysis history.
6. Model-version view.
7. Dataset-provenance view.
8. Human-review form.
9. Experiment-comparison view.

Required UI states:

- Empty state.
- Loading state.
- API failure.
- Invalid input.
- Low-confidence result.
- Conflicting evidence.
- No matching candidates.
- Research-only warning.
- Download or export result.

## Phase 8: Evaluation

### AMR metrics

- AUROC.
- AUPRC.
- F1 score.
- Sensitivity.
- Specificity.
- Expected calibration error.
- Performance by organism.
- Performance by antibiotic.
- Performance by laboratory.
- Performance by collection year.

### Rare-disease metrics

- Top-1 accuracy.
- Top-5 accuracy.
- Mean reciprocal rank.
- Recall at K.
- Calibration error.
- Robustness under missing phenotypes.
- Robustness under noisy phenotype names.
- Explanation agreement with source evidence.

## Phase 9: Testing

- Unit tests for data normalization.
- Unit tests for scoring logic.
- API contract tests.
- Model input/output tests.
- Database integration tests.
- Frontend component tests.
- Playwright workflow tests.
- Mobile and desktop browser validation.
- Dataset reproducibility test.
- Security tests for uploaded files and request payloads.

## Phase 10: Deployment

### Local Docker Compose services

```text
frontend
backend
ml-service
postgres
data-worker
```

### Production requirements

- Build the frontend into static assets.
- Deploy the backend behind HTTPS.
- Deploy the ML service separately.
- Store datasets in object storage.
- Store credentials only in environment secrets.
- Add request logging and rate limits.
- Add database backups.
- Add model and dataset versioning.

## Completion Criteria

The project is complete when:

- Both workflows work in the browser.
- API and ML services run independently.
- Dataset versions are recorded.
- Predictions expose confidence and evidence.
- AMR results require laboratory confirmation.
- Rare-disease results state that they are not clinical diagnoses.
- Models are evaluated against documented baselines.
- Results and feedback persist in the database.
- Desktop and mobile workflows pass browser tests.
- The production build succeeds.
- Deployment instructions are reproducible.

## Immediate Next Steps

1. Replace the unavailable assembly and verify 100 usable FASTA files.
2. Run the supported mutation-analysis tools on the pilot, then link and validate any calls against AMR observations.
3. Refresh the processing report warning so it matches the completed 10,000-record feature extraction.
4. Build and evaluate the gene/resistance-feature-only AMR baseline and the HPO semantic-similarity baseline.
5. Continue with database persistence, API integration, frontend workflows, evaluation, and deployment tasks.
