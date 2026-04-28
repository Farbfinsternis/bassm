// ============================================================================
// helpers.js — Re-export shim for legacy tests
// ============================================================================
//
// The canonical pipeline factory now lives in tests-v2/_pipeline.js (S3-T02).
// This shim keeps the legacy `tests/` suite compiling without churn until it is
// fully migrated to tests-v2/ (S3-T05 / M4-T01). Anything new should import
// directly from tests-v2/_pipeline.js.

export { makePipeline, COMMANDS, KEYWORDS } from '../tests-v2/_pipeline.js';
