"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createTask, updateTask, deleteTask } from "@/app/actions";
import { Task, Mode, Priority, Status } from "@/lib/types";
import { MODES } from "@/lib/modes";

const PRIORITIES: Priority[] = ["P1", "P2", "P3", "P4"];
const STATUSES: Status[] = [
  "Not Started",
  "In Progress",
  "Blocked",
  "Done",
  "Dropped",
];

type Props = {
  open: boolean;
  onClose: () => void;
  task?: Task;
  defaultMode?: Mode;
};

export function TaskForm({ open, onClose, task, defaultMode }: Props) {
  const isEdit = !!task;
  const [pending, startTransition] = useTransition();

  const [fields, setFields] = useState({
    task: task?.task ?? "",
    mode: task?.mode ?? defaultMode ?? ("Code & Dev" as Mode),
    projectClient: task?.projectClient ?? "",
    priority: task?.priority ?? ("P2" as Priority),
    estimateMins: task?.estimateMins ?? 30,
    due: task?.due ?? "",
    status: task?.status ?? ("Not Started" as Status),
    notes: task?.notes ?? "",
  });

  function set<K extends keyof typeof fields>(k: K, v: (typeof fields)[K]) {
    setFields((prev) => ({ ...prev, [k]: v }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        if (isEdit) {
          await updateTask(task!.id, fields);
          toast.success("Task updated.");
        } else {
          await createTask(fields);
          toast.success("Task created.");
        }
        onClose();
      } catch {
        toast.error("Something went wrong.");
      }
    });
  }

  function handleDelete() {
    if (!task) return;
    startTransition(async () => {
      try {
        await deleteTask(task.id);
        toast.success("Task deleted.");
        onClose();
      } catch {
        toast.error("Failed to delete.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Task" : "Add Task"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="task">Task *</Label>
            <Input
              id="task"
              value={fields.task}
              onChange={(e) => set("task", e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Mode *</Label>
              <Select
                value={fields.mode}
                onValueChange={(v) => set("mode", v as Mode)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODES.map((m) => (
                    <SelectItem key={m.name} value={m.name}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project">Project / Client</Label>
              <Input
                id="project"
                value={fields.projectClient}
                onChange={(e) => set("projectClient", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select
                value={fields.priority}
                onValueChange={(v) => set("priority", v as Priority)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="estimate">Estimate (min)</Label>
              <Input
                id="estimate"
                type="number"
                min={0}
                value={fields.estimateMins}
                onChange={(e) =>
                  set("estimateMins", parseInt(e.target.value) || 0)
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="due">Due Date</Label>
              <Input
                id="due"
                type="date"
                value={fields.due}
                onChange={(e) => set("due", e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select
              value={fields.status}
              onValueChange={(v) => set("status", v as Status)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={fields.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
            />
          </div>

          <div className="flex justify-between pt-1">
            {isEdit ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20"
                onClick={handleDelete}
                disabled={pending}
              >
                Delete
              </Button>
            ) : (
              <div />
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !fields.task.trim()}>
                {pending ? "Saving…" : isEdit ? "Save" : "Add Task"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
