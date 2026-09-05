/**
 * Tracks one stream's `seq` values. Sequence numbers must be strictly
 * increasing per stream; a repeat is a duplicate (safe to ignore), and a
 * smaller value is out of order (a reordered or replayed batch).
 */
export type SeqVerdict = "accepted" | "duplicate" | "out_of_order";

export interface SeqTracker {
  /** Highest sequence accepted so far, or undefined before the first. */
  readonly last: number | undefined;
  accept(seq: number): SeqVerdict;
}

export function createSeqTracker(): SeqTracker {
  let last: number | undefined;
  return {
    get last() {
      return last;
    },
    accept(seq) {
      if (last === undefined || seq > last) {
        last = seq;
        return "accepted";
      }
      return seq === last ? "duplicate" : "out_of_order";
    }
  };
}
