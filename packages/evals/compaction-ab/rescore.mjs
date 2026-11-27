// Re-grade a finished run directory from its saved answers (when a grader changes).
import { readFile, writeFile } from "node:fs/promises"; import { join } from "node:path";
import { TASKS } from "./tasks.mjs";
for (const dir of process.argv.slice(2)) {
  const record = JSON.parse(await readFile(join(dir, "record.json"), "utf8"));
  record.grade = await TASKS[record.task].grade(join(dir, "workspace"), record.wakes.map((w) => w.answer));
  await writeFile(join(dir, "record.json"), JSON.stringify(record, null, 1));
  console.log(dir, JSON.stringify(record.grade));
}
