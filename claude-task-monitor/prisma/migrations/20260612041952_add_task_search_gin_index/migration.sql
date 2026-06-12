-- Enable pg_trgm for trigram-based GIN indexes (supports fast ILIKE queries)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index on Task.title — accelerates ILIKE '%q%' on title
CREATE INDEX IF NOT EXISTS "Task_title_trgm_idx" ON "Task" USING gin (title gin_trgm_ops);

-- GIN trigram index on Task.description — accelerates ILIKE '%q%' on description
CREATE INDEX IF NOT EXISTS "Task_description_trgm_idx" ON "Task" USING gin (description gin_trgm_ops);

-- GIN trigram index on ExecutionLog.outputSummary — accelerates log search
CREATE INDEX IF NOT EXISTS "ExecutionLog_outputSummary_trgm_idx" ON "ExecutionLog" USING gin ("outputSummary" gin_trgm_ops);
