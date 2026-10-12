"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Task, Status } from "@/lib/types";
import { updateTask } from "@/app/actions";
import { PriorityBadge } from "@/components/priority-badge";
import { TaskForm } from "@/components/task-form";
import { CheckCircle2, Pencil } from "lucide-react";
import { MODES } from "@/lib/modes";

const STATUSES: Status[] = [
  "Not Started",
  "In Progress",
  "Blocked",
  "Done",
  "Dropped",
];

const STATUS_STYLES: Record<Status, string> = {
  "Not Started": "text-gray-500 dark:text-gray-400",
  "In Progress": "text-blue-600 dark:text-blue-400",
  Blocked: "text-red-600 dark:text-red-400",
  Done: "text-green-600 dark:text-green-400",
  Dropped: "text-gray-400 dark:text-gray-500 line-through",
};

type Props = {
  tasks: Task[];
  showMode?: boolean;
};

export function TaskTable({ tasks, showMode = false }: Props) {
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [pending, startTransition] = useTransition();

  function changeStatus(id: string, status: Status) {
    startTransition(async () => {
      await updateTask(id, { status });
      toast.success(`Status updated to "${status}".`);
    });
  }

  function markDone(id: string) {
    startTransition(async () => {
      await updateTask(id, { status: "Done" });
      toast.success("Marked done.");
    });
  }

  function fmtDate(d?: string) {
    if (!d) return "—";
    try {
      return format(parseISO(d), "MMM d");
    } catch {
      return d;
    }
  }

  if (tasks.length === 0) {
    return (
      <div className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">
        No tasks.
      </div>
    );
  }

  return (
    <>
      <div className="border rounded overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="text-xs">
              {showMode && <TableHead>Mode</TableHead>}
              <TableHead>Task</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Est.</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Touched</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead className="w-20"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((task) => (
              <TableRow
                key={task.id}
                className={
                  task.status === "Done" || task.status === "Dropped"
                    ? "opacity-50"
                    : ""
                }
              >
                {showMode && (
                  <TableCell className="text-xs">
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium"
                      style={{
                        backgroundColor:
                          (MODES.find((m) => m.name === task.mode)?.hex || "#374151") + "18",
                        color:
                          MODES.find((m) => m.name === task.mode)?.hex ||
                          "#374151",
                      }}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{
                          backgroundColor:
                            MODES.find((m) => m.name === task.mode)?.hex ||
                            "#374151",
                        }}
                      />
                      {task.mode}
                    </span>
                  </TableCell>
                )}
                <TableCell className="font-medium max-w-xs">
                  <span
                    className={
                      task.status === "Dropped"
                        ? "line-through text-gray-400 dark:text-gray-500"
                        : ""
                    }
                  >
                    {task.task}
                  </span>
                </TableCell>
                <TableCell className="text-gray-500 dark:text-gray-400 text-sm">
                  {task.projectClient || "—"}
                </TableCell>
                <TableCell>
                  <PriorityBadge priority={task.priority} />
                </TableCell>
                <TableCell className="text-gray-500 dark:text-gray-400 text-sm">
                  {task.estimateMins}m
                </TableCell>
                <TableCell className="text-gray-500 dark:text-gray-400 text-sm">
                  {fmtDate(task.due)}
                </TableCell>
                <TableCell>
                  <Select
                    value={task.status}
                    onValueChange={(v) => changeStatus(task.id, v as Status)}
                    disabled={pending}
                  >
                    <SelectTrigger
                      className={`h-7 text-xs w-32 ${STATUS_STYLES[task.status]}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((s) => (
                        <SelectItem key={s} value={s} className="text-xs">
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-gray-500 dark:text-gray-400 text-sm">
                  {fmtDate(task.lastTouched)}
                </TableCell>
                <TableCell className="text-gray-400 dark:text-gray-500 text-xs max-w-xs truncate">
                  {task.notes || "—"}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {task.status !== "Done" && task.status !== "Dropped" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/20"
                        onClick={() => markDone(task.id)}
                        disabled={pending}
                        title="Mark Done"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                      onClick={() => setEditTask(task)}
                      title="Edit"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {editTask && (
        <TaskForm
          open={!!editTask}
          onClose={() => setEditTask(null)}
          task={editTask}
        />
      )}
    </>
  );
}
