CREATE TABLE model_versions (
  version text PRIMARY KEY,
  family text NOT NULL,
  description text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  registered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dataset_versions (
  version text PRIMARY KEY,
  source text NOT NULL,
  sha256 text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  registered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analysis_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow text NOT NULL CHECK (workflow IN ('amr', 'rare_disease', 'sequence_native')),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  input_data jsonb NOT NULL,
  result_data jsonb,
  error_message text,
  model_version text REFERENCES model_versions(version),
  dataset_version text REFERENCES dataset_versions(version),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX analysis_runs_created_at_idx ON analysis_runs (created_at DESC);
CREATE INDEX analysis_runs_workflow_status_idx ON analysis_runs (workflow, status);

CREATE TABLE review_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('accept', 'reject', 'needs_review')),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX review_feedback_analysis_id_idx ON review_feedback (analysis_id, created_at DESC);
