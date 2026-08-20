/**
 * Port of the official GAIA scorer (gaia-benchmark leaderboard
 * `scorer.py`): numbers compare as floats after stripping $ % and commas,
 * comma/semicolon lists compare element-wise, everything else compares as
 * lowercase text with whitespace (and by default punctuation) removed.
 */

const PUNCTUATION = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".split(""));

export function scoreGaiaAnswer(modelAnswer: string | undefined, groundTruth: string): boolean {
  if (modelAnswer === undefined || modelAnswer === null) {
    return false;
  }
  if (isFloat(groundTruth)) {
    return normalizeNumberStr(modelAnswer) === Number.parseFloat(groundTruth);
  }
  if (groundTruth.includes(",") || groundTruth.includes(";")) {
    const truthElements = splitString(groundTruth);
    const answerElements = splitString(modelAnswer);
    if (answerElements.length !== truthElements.length) {
      return false;
    }
    return truthElements.every((truthElement, index) => {
      const answerElement = answerElements[index];
      if (isFloat(truthElement)) {
        return normalizeNumberStr(answerElement) === Number.parseFloat(truthElement);
      }
      return normalizeStr(answerElement, false) === normalizeStr(truthElement, false);
    });
  }
  return normalizeStr(modelAnswer) === normalizeStr(groundTruth);
}

export function extractFinalAnswer(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const matches = [...text.matchAll(/FINAL ANSWER:\s*(.+)/gi)];
  const last = matches.at(-1)?.[1]?.trim();
  return last && last.length > 0 ? last : undefined;
}

export function isFloat(value: string | number): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return false;
  }
  return Number.isFinite(Number(trimmed));
}

export function normalizeNumberStr(value: string): number {
  const cleaned = value.replace(/[$%,]/g, "").trim();
  const parsed = Number.parseFloat(cleaned);
  // The official scorer maps unparseable answers to float("inf") so they
  // never match a real ground truth.
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function splitString(value: string, chars: string[] = [",", ";"]): string[] {
  const pattern = new RegExp(`[${chars.join("")}]`);
  return value.split(pattern).map((element) => element.trim());
}

export function normalizeStr(value: string, removePunct = true): string {
  const noSpace = value.replace(/\s+/g, "");
  const lower = noSpace.toLowerCase();
  if (!removePunct) {
    return lower;
  }
  return [...lower].filter((char) => !PUNCTUATION.has(char)).join("");
}
