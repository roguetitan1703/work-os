import { Badge } from "@/components/ui/badge";
import { Priority } from "@/lib/types";

const PRIORITY_STYLES: Record<Priority, string> = {
  P1: "bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800",
  P2: "bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-800",
  P3: "bg-yellow-100 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800",
  P4: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700",
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <Badge
      variant="outline"
      className={`font-mono text-xs ${PRIORITY_STYLES[priority]}`}
    >
      {priority}
    </Badge>
  );
}
