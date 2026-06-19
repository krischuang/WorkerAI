-- P3-7: Prevent agent session collisions — two agents on the same server
-- must not share a tmuxSession name, as this causes dispatch ambiguity.
CREATE UNIQUE INDEX "Agent_serverId_tmuxSession_key" ON "Agent"("serverId", "tmuxSession");
