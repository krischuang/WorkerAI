-- CreateTable
CREATE TABLE "TaskTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "taskType" "TaskType" NOT NULL DEFAULT 'coding',
    "estimatedCostLevel" "CostLevel" NOT NULL DEFAULT 'medium',
    "priority" "Priority" NOT NULL DEFAULT 'P3',
    "titleTemplate" TEXT NOT NULL,
    "descriptionTemplate" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskTemplate_category_idx" ON "TaskTemplate"("category");

-- CreateIndex
CREATE INDEX "TaskTemplate_isBuiltIn_idx" ON "TaskTemplate"("isBuiltIn");
