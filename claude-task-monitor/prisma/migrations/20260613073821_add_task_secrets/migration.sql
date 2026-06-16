-- CreateTable
CREATE TABLE "TaskSecret" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskSecret_taskId_idx" ON "TaskSecret"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskSecret_taskId_key_key" ON "TaskSecret"("taskId", "key");

-- AddForeignKey
ALTER TABLE "TaskSecret" ADD CONSTRAINT "TaskSecret_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
