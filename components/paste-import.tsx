"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  parseMarkdownTable,
  ParsedTaskInput,
} from "@/lib/parse-markdown-table";
import { bulkCreateTasksAction } from "@/app/actions";
import type { Mode, Priority, Status } from "@/lib/types";
import { useModes } from "@/components/app-context";
import { PriorityBadge } from "@/components/priority-badge";

type Tab = "markdown" | "json";
type Props = { open: boolean; onClose: () => void };

const JSON_SCHEMA_HINT = `Ask Claude to output a JSON array like this:
[
  {
    "title": "Write proposal for Acme",
    "mode": "Client Delivery",
    "project": "Acme Corp",
    "priority": "P1",
    "estimateMins": 45,
    "due": "2026-05-10",
    "status": "Not Started",
    "description": ""
  }
]

Modes: {MODES}
Priority: P1 | P2 | P3 | P4
Status: Not Started | In Progress | Blocked | Done | Dropped`;

function parseJSON(raw: string, VALID_MODES: readonly string[]): {
  tasks: ParsedTaskInput[];
  errors: string[];
} {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    // Strip markdown code fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    errors.push("Invalid JSON. Make sure it is a valid JSON array.");
    return { tasks: [], errors };
  }

  if (!Array.isArray(parsed)) {
    errors.push("Expected a JSON array [ ... ].");
    return { tasks: [], errors };
  }

  const VALID_PRIORITIES = ["P1", "P2", "P3", "P4"];
  const VALID_STATUSES = [
    "Not Started",
    "In Progress",
    "Blocked",
    "Done",
    "Dropped",
  ];

  const tasks: ParsedTaskInput[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i] as Record<string, unknown>;
    const rowNum = i + 1;

    const title = row.title ?? row.task;
    if (!title || typeof title !== "string" || !title.trim()) {
      errors.push(`Row ${rowNum}: missing "title"`);
      continue;
    }
    if (row.mode && !VALID_MODES.includes(row.mode as string)) {
      errors.push(
        `Row ${rowNum}: invalid mode "${row.mode}". Must be one of: ${VALID_MODES.join(", ")}`,
      );
      continue;
    }

    const priority =
      typeof row.priority === "string" &&
      VALID_PRIORITIES.includes(row.priority.toUpperCase())
        ? row.priority.toUpperCase()
        : "P2";

    const status =
      typeof row.status === "string"
        ? (VALID_STATUSES.find(
            (s) => s.toLowerCase() === row.status!.toString().toLowerCase(),
          ) ?? "Not Started")
        : "Not Started";

    const estimateMins =
      typeof row.estimateMins === "number" && row.estimateMins >= 0
        ? Math.round(row.estimateMins)
        : null;

    const due =
      typeof row.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.due)
        ? row.due
        : undefined;

    tasks.push({
      title: title.trim(),
      mode: (row.mode as Mode) ?? null,
      project:
        typeof (row.project ?? row.projectClient) === "string" ? String(row.project ?? row.projectClient) || null : null,
      priority: priority as Priority,
      estimateMins,
      due,
      status: status as Status,
      description: typeof (row.description ?? row.notes) === "string" ? String(row.description ?? row.notes) : "",
    });
  }

  return { tasks, errors };
}

export function PasteImportDialog({ open, onClose }: Props) {
  const { names } = useModes();
  const [tab, setTab] = useState<Tab>("markdown");
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<
    { task: ParsedTaskInput; checked: boolean }[] | null
  >(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);

  function handlePreview() {
    const result =
      tab === "markdown" ? parseMarkdownTable(raw, names) : parseJSON(raw, names);
    setErrors(result.errors);
    if (result.tasks.length > 0) {
      setPreview(result.tasks.map((t) => ({ task: t, checked: true })));
    }
  }

  function toggleRow(idx: number) {
    setPreview((prev) =>
      prev
        ? prev.map((r, i) => (i === idx ? { ...r, checked: !r.checked } : r))
        : prev,
    );
  }

  async function handleInsert() {
    if (!preview) return;
    const selected = preview.filter((r) => r.checked).map((r) => r.task);
    if (selected.length === 0) return;
    setImporting(true);
    try {
      const res = await bulkCreateTasksAction(selected);
      if (!res.ok) throw new Error(res.error);
      toast.success(
        `Inserted ${selected.length} task${selected.length !== 1 ? "s" : ""}. View them in Today or by mode.`,
      );
      resetAndClose();
    } catch {
      toast.error("Failed to insert tasks. Please try again.");
    } finally {
      setImporting(false);
    }
  }

  function resetAndClose() {
    setRaw("");
    setPreview(null);
    setErrors([]);
    onClose();
  }

  function switchTab(t: Tab) {
    setTab(t);
    setRaw("");
    setPreview(null);
    setErrors([]);
  }

  const checkedCount = preview?.filter((r) => r.checked).length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && resetAndClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Tasks</DialogTitle>
          <DialogDescription>
            Paste from Claude as a markdown table or JSON array.
          </DialogDescription>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 w-fit">
          <TabBtn
            active={tab === "markdown"}
            onClick={() => switchTab("markdown")}
          >
            Markdown Table
          </TabBtn>
          <TabBtn active={tab === "json"} onClick={() => switchTab("json")}>
            JSON Array
          </TabBtn>
        </div>

        {!preview ? (
          <div className="space-y-3">
            {tab === "markdown" ? (
              <>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Ask Claude to output:{" "}
                  <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">
                    | Task | Mode | Project | Priority | Estimate | Due |
                    Status | Notes |
                  </code>
                </p>
                <Textarea
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  placeholder="Paste your markdown table here…"
                  className="min-h-48 font-mono text-sm"
                />
              </>
            ) : (
              <>
                <pre className="text-xs bg-gray-50 dark:bg-gray-900 border rounded p-3 overflow-auto text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                  {JSON_SCHEMA_HINT.replace("{MODES}", names.join(" | "))}
                </pre>
                <Textarea
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  placeholder="Paste JSON array here…"
                  className="min-h-48 font-mono text-sm"
                />
              </>
            )}

            {errors.length > 0 && (
              <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded p-2 space-y-1">
                {errors.map((e, i) => (
                  <div key={i}>⚠ {e}</div>
                ))}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={resetAndClose}>
                Cancel
              </Button>
              <Button onClick={handlePreview} disabled={!raw.trim()}>
                Preview
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {errors.length > 0 && (
              <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded p-2 space-y-1">
                {errors.map((e, i) => (
                  <div key={i}>⚠ {e}</div>
                ))}
              </div>
            )}
            <div className="border rounded overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800 text-xs text-gray-500 dark:text-gray-400 uppercase">
                  <tr>
                    <th className="px-3 py-2 w-8"></th>
                    <th className="px-3 py-2 text-left">Task</th>
                    <th className="px-3 py-2 text-left">Kind of work</th>
                    <th className="px-3 py-2 text-left">Project</th>
                    <th className="px-3 py-2 text-left">Priority</th>
                    <th className="px-3 py-2 text-left">Est.</th>
                    <th className="px-3 py-2 text-left">Due</th>
                    <th className="px-3 py-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row, idx) => (
                    <tr
                      key={idx}
                      className={`border-t ${!row.checked ? "opacity-40" : ""}`}
                    >
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={row.checked}
                          onCheckedChange={() => toggleRow(idx)}
                        />
                      </td>
                      <td className="px-3 py-2 font-medium max-w-xs truncate">
                        {row.task.title}
                      </td>
                      <td className="px-3 py-2 text-gray-600 dark:text-gray-400 text-xs">
                        {row.task.mode ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400">
                        {row.task.project || "—"}
                      </td>
                      <td className="px-3 py-2">
                        <PriorityBadge priority={row.task.priority} />
                      </td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400">
                        {row.task.estimateMins ? `${row.task.estimateMins}m` : "—"}
                      </td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400">
                        {row.task.due || "—"}
                      </td>
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs">
                        {row.task.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-2 justify-between items-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPreview(null)}
              >
                ← Back
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={resetAndClose}>
                  Cancel
                </Button>
                <Button
                  onClick={handleInsert}
                  disabled={checkedCount === 0 || importing}
                >
                  {importing
                    ? "Inserting…"
                    : `Insert ${checkedCount} task${checkedCount !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
        active
          ? "bg-white dark:bg-gray-700 shadow-sm text-gray-900 dark:text-gray-100"
          : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
      }`}
    >
      {children}
    </button>
  );
}
