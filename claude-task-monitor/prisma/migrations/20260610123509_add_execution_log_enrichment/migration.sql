-- AlterTable
ALTER TABLE "ExecutionLog" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "exitReason" TEXT,
ADD COLUMN     "paneCapture" TEXT,
ADD COLUMN     "searchVector" tsvector;

-- CreateIndex
CREATE INDEX "ExecutionLog_taskId_idx" ON "ExecutionLog"("taskId");

-- CreateIndex
CREATE INDEX "ExecutionLog_archivedAt_idx" ON "ExecutionLog"("archivedAt");

-- CreateIndex
CREATE INDEX "ExecutionLog_finishedAt_idx" ON "ExecutionLog"("finishedAt");

-- GIN index for full-text search
CREATE INDEX "ExecutionLog_searchVector_gin_idx" ON "ExecutionLog" USING GIN("searchVector");

-- Trigger function: auto-populate searchVector on insert/update
CREATE OR REPLACE FUNCTION execution_log_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW."searchVector" = to_tsvector('english',
    COALESCE(NEW."logText", '') || ' ' ||
    COALESCE(NEW."outputSummary", '') || ' ' ||
    COALESCE(NEW."errorMessage", '') || ' ' ||
    COALESCE(NEW."exitReason", '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_log_search_vector_trigger
  BEFORE INSERT OR UPDATE ON "ExecutionLog"
  FOR EACH ROW EXECUTE FUNCTION execution_log_search_vector_update();
