"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { StatusBadge } from "@/app/_components/StatusBadge";
import { PriorityBadge } from "@/app/_components/PriorityBadge";
import {
  BackLink,
  LoadingState,
  Modal,
  Btn,
  ModalActions,
  FormField,
  inputCls,
} from "@/app/_components/ui";

interface ExecutionLog {
  id: string;
  status: string;
  logText: string | null;
  errorMessage: string | null;
  outputSummary: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  taskType: string;
  estimatedCostLevel: string;
  resultSummary: string | null;
  nextAction: string | null;
  createdAt: string;
  updatedAt: string;
  project: { id: string; name: string; priority: string };
  executionLogs: ExecutionLog[];
}

const STATUS_BUTTONS = [
  { label: "Running", status: "running", color: "bg-blue-700 hover:bg-blue-800" },
  { label: "Paused", status: "paused", color: "bg-amber-600 hover:bg-amber-700" },
  { label: "Completed", status: "completed", color: "bg-green-700 hover:bg-green-800" },
  { label: "Failed", status: "failed", color: "bg-red-700 hover:bg-red-800" },
];

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [task, setTask] = useState<Task | null>(null);
  const [showLogForm, setShowLogForm] = useState(false);
  const [showSummaryForm, setShowSummaryForm] = useState(false);
  const [logForm, setLogForm] = useState({
    status: "completed",
    logText: "",
    errorMessage: "",
    outputSummary: "",
  });
  const [summaryForm, setSummaryForm] = useState({
    resultSummary: "",
    nextAction: "",
  });

  function loadTask() {
    fetch(`/api/tasks/${id}`)
      .then((r) => {
        if (!r.ok) { router.push("/projects"); return null; }
        return r.json();
      })
      .then((data) => {
        if (!data) return;
        setTask(data);
        setSummaryForm({
          resultSummary: data.resultSummary ?? "",
          nextAction: data.nextAction ?? "",
        });
      });
  }

  useEffect(() => {
    loadTask();
  }, [id]);

  async function updateStatus(status: string) {
    await fetch(`/api/tasks/${id}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    loadTask();
  }

  async function handleAddLog(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`/api/tasks/${id}/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...logForm, finishedAt: new Date().toISOString() }),
    });
    setShowLogForm(false);
    setLogForm({ status: "completed", logText: "", errorMessage: "", outputSummary: "" });
    loadTask();
  }

  async function handleSaveSummary(e: React.FormEvent) {
    e.preventDefault();
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summaryForm),
    });
    setShowSummaryForm(false);
    loadTask();
  }

  if (!task) return <LoadingState />;

  return (
    <div className="p-8 max-w-4xl">
      <BackLink href={`/projects/${task.project.id}`} label={task.project.name} />

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{task.title}</h1>
          {task.description && (
            <p className="text-sm text-zinc-700 mt-1 max-w-2xl">{task.description}</p>
          )}
        </div>
        <div className="flex gap-2 shrink-0 ml-4">
          <PriorityBadge priority={task.priority} />
          <StatusBadge status={task.status} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-white rounded-lg border border-zinc-200 p-3">
          <p className="text-xs text-zinc-600 font-medium mb-0.5">Type</p>
          <p className="text-sm font-semibold text-zinc-900">{task.taskType}</p>
        </div>
        <div className="bg-white rounded-lg border border-zinc-200 p-3">
          <p className="text-xs text-zinc-600 font-medium mb-0.5">Estimated Cost</p>
          <p className="text-sm font-semibold text-zinc-900">{task.estimatedCostLevel}</p>
        </div>
        <div className="bg-white rounded-lg border border-zinc-200 p-3">
          <p className="text-xs text-zinc-600 font-medium mb-0.5">Project Priority</p>
          <p className="text-sm font-semibold text-zinc-900">{task.project.priority}</p>
        </div>
      </div>

      <section className="bg-white rounded-xl border border-zinc-200 p-5 mb-6">
        <h2 className="font-semibold text-zinc-900 mb-3">Execution Controls</h2>
        <div className="flex flex-wrap gap-2">
          {STATUS_BUTTONS.map(({ label, status, color }) => (
            <button
              key={status}
              onClick={() => updateStatus(status)}
              disabled={task.status === status}
              className={`text-sm text-white font-medium px-4 py-2 rounded-lg transition-colors ${color} disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              Mark {label}
            </button>
          ))}
          <Btn variant="ghost" onClick={() => setShowLogForm(true)}>
            + Add Log
          </Btn>
          <Btn variant="ghost" onClick={() => setShowSummaryForm(true)}>
            Save Result
          </Btn>
        </div>
      </section>

      {(task.resultSummary || task.nextAction) && (
        <section className="bg-white rounded-xl border border-zinc-200 p-5 mb-6 space-y-4">
          {task.resultSummary && (
            <div>
              <p className="text-xs font-semibold text-zinc-600 uppercase tracking-wide mb-1.5">
                Result Summary
              </p>
              <p className="text-sm text-zinc-800 whitespace-pre-wrap">{task.resultSummary}</p>
            </div>
          )}
          {task.nextAction && (
            <div>
              <p className="text-xs font-semibold text-zinc-600 uppercase tracking-wide mb-1.5">
                Next Action
              </p>
              <p className="text-sm text-zinc-800 whitespace-pre-wrap">{task.nextAction}</p>
            </div>
          )}
        </section>
      )}

      <section>
        <h2 className="font-semibold text-zinc-900 mb-3">
          Execution Logs ({task.executionLogs.length})
        </h2>
        {task.executionLogs.length === 0 ? (
          <div className="bg-white rounded-xl border border-zinc-200 p-6 text-center">
            <p className="text-sm text-zinc-600">No execution logs yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {task.executionLogs.map((log) => (
              <div key={log.id} className="bg-white rounded-xl border border-zinc-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <StatusBadge status={log.status} />
                  <span className="text-xs text-zinc-600">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                </div>
                {log.logText && (
                  <pre className="text-xs text-zinc-700 bg-zinc-50 rounded-lg p-3 mt-2 overflow-x-auto whitespace-pre-wrap font-mono">
                    {log.logText}
                  </pre>
                )}
                {log.outputSummary && (
                  <p className="text-sm text-zinc-800 mt-2">
                    <span className="font-medium text-zinc-700">Output: </span>
                    {log.outputSummary}
                  </p>
                )}
                {log.errorMessage && (
                  <p className="text-sm text-red-700 mt-2">
                    <span className="font-medium">Error: </span>
                    {log.errorMessage}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {showLogForm && (
        <Modal title="Add Execution Log" onClose={() => setShowLogForm(false)} size="lg">
          <form onSubmit={handleAddLog} className="space-y-4">
            <FormField label="Status">
              <select
                value={logForm.status}
                onChange={(e) => setLogForm({ ...logForm, status: e.target.value })}
                className={inputCls}
              >
                {["pending", "running", "paused", "completed", "failed"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Log Text">
              <textarea
                value={logForm.logText}
                onChange={(e) => setLogForm({ ...logForm, logText: e.target.value })}
                rows={5}
                placeholder="Paste Claude's output or your notes here…"
                className={`${inputCls} font-mono`}
              />
            </FormField>
            <FormField label="Output Summary">
              <input
                value={logForm.outputSummary}
                onChange={(e) => setLogForm({ ...logForm, outputSummary: e.target.value })}
                placeholder="One-line summary of what was produced"
                className={inputCls}
              />
            </FormField>
            <FormField label="Error Message">
              <input
                value={logForm.errorMessage}
                onChange={(e) => setLogForm({ ...logForm, errorMessage: e.target.value })}
                placeholder="Error details if status is failed"
                className={inputCls}
              />
            </FormField>
            <ModalActions>
              <Btn type="submit" variant="primary" className="flex-1">
                Save Log
              </Btn>
              <Btn type="button" variant="secondary" className="flex-1" onClick={() => setShowLogForm(false)}>
                Cancel
              </Btn>
            </ModalActions>
          </form>
        </Modal>
      )}

      {showSummaryForm && (
        <Modal title="Result Summary & Next Action" onClose={() => setShowSummaryForm(false)} size="lg">
          <form onSubmit={handleSaveSummary} className="space-y-4">
            <FormField label="Result Summary">
              <textarea
                value={summaryForm.resultSummary}
                onChange={(e) => setSummaryForm({ ...summaryForm, resultSummary: e.target.value })}
                rows={4}
                placeholder="What was accomplished?"
                className={inputCls}
              />
            </FormField>
            <FormField label="Next Action">
              <textarea
                value={summaryForm.nextAction}
                onChange={(e) => setSummaryForm({ ...summaryForm, nextAction: e.target.value })}
                rows={3}
                placeholder="What should happen next?"
                className={inputCls}
              />
            </FormField>
            <ModalActions>
              <Btn type="submit" variant="primary" className="flex-1">
                Save
              </Btn>
              <Btn type="button" variant="secondary" className="flex-1" onClick={() => setShowSummaryForm(false)}>
                Cancel
              </Btn>
            </ModalActions>
          </form>
        </Modal>
      )}
    </div>
  );
}
