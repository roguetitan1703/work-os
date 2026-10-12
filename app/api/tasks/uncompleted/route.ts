import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export async function GET() {
  try {
    const dataPath = path.join(process.cwd(), "data", "tasks.json");
    const raw = await fs.readFile(dataPath, "utf8");
    const json = JSON.parse(raw);

    const tasks = Array.isArray(json.tasks) ? json.tasks : [];
    const uncompleted = tasks.filter((t: any) => {
      const status = (t.status || "").toString().toLowerCase();
      return status !== "done" && status !== "completed";
    });

    return NextResponse.json({ count: uncompleted.length, tasks: uncompleted });
  } catch (err) {
    return NextResponse.json({ error: "failed to read tasks" }, { status: 500 });
  }
}
