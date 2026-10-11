ALTER TABLE analysis_runs DROP CONSTRAINT IF EXISTS analysis_runs_workflow_check;
ALTER TABLE analysis_runs ADD CONSTRAINT analysis_runs_workflow_check
  CHECK (workflow IN ('amr', 'rare_disease', 'sequence_native'));