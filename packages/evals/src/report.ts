import type { GaiaReport } from "./runner.js";

export function renderGaiaReport(report: GaiaReport): string {
  const lines: string[] = [
    `GAIA ${report.tier} — run ${report.run_id}`,
    `questions: ${report.selected_questions} selected, ${report.selected_questions - report.skipped.length} run, ${report.skipped.length} skipped (unsupported modality)`,
    `results: ${report.results_dir}`,
    ""
  ];
  const header = ["harness", "accuracy", "L1", "L2", "L3", "mean cost", "median cost", "errors", "cost basis"];
  const rows = report.harnesses.map((harness) => [
    harness.name,
    `${harness.correct}/${harness.answered} (${percent(harness.accuracy)})`,
    levelCell(harness.accuracy_by_level["1"]),
    levelCell(harness.accuracy_by_level["2"]),
    levelCell(harness.accuracy_by_level["3"]),
    costCell(harness),
    harness.median_cost_cents !== undefined ? usd(harness.median_cost_cents / 100) : "-",
    String(harness.errors),
    harness.cost_basis
  ]);
  lines.push(renderTable([header, ...rows]));
  lines.push("");
  lines.push("OpenCrowd cost is measured on-chain USDC spend; claude/codex costs are token/list-price estimates billed to their own accounts — the columns are not identical.");
  if (report.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped questions (counted against coverage, not accuracy):");
    for (const skip of report.skipped) {
      lines.push(`  - ${skip.task_id} (level ${skip.level}): ${skip.reason}`);
    }
  }
  return lines.join("\n");
}

function levelCell(entry?: { answered: number; correct: number; accuracy: number }): string {
  if (!entry || entry.answered === 0) {
    return "-";
  }
  return `${entry.correct}/${entry.answered}`;
}

function costCell(harness: GaiaReport["harnesses"][number]): string {
  if (harness.mean_cost_cents !== undefined) {
    return usd(harness.mean_cost_cents / 100);
  }
  if (harness.mean_estimated_cost_usd !== undefined) {
    return `~${usd(harness.mean_estimated_cost_usd)}`;
  }
  return "-";
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderTable(rows: string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
  return rows
    .map((row) => row.map((cell, column) => (cell ?? "").padEnd(widths[column])).join("  ").trimEnd())
    .join("\n");
}
