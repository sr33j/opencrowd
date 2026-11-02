/**
 * A final message that answers nothing: a bare acknowledgement ("Acknowledged.",
 * "Done.") or a promise of an answer to come ("I'm preparing the current,
 * source-cited answer now."). gpt-5.6-luna ended two tool-heavy runs of sixty
 * this way, and the owner, who never sees tool results, got no answer (SRI-79).
 *
 * Deliberately narrow: a false positive costs one extra model turn, but a
 * message only qualifies when it is short, carries no link and is wholly an
 * acknowledgement or a statement that the answer is still coming.
 */
const ACKNOWLEDGEMENT = /^(?:ok(?:ay)?|acknowledged|noted|understood|done|got it|sure|will do|on it|roger(?: that)?|thanks?(?: you)?|all done|complete(?:d)?|finished)(?:[.!]|\s*(?:—|-|,)\s*(?:thanks?(?: you)?|done))*$/i;
const ME = String.raw`(?:i(?:['’]?m| am)|i(?:['’]ll| will)(?: now)?|we(?:['’]re| are)|we(?:['’]ll| will)(?: now)?|now i(?:['’]ll| will)|next,? i(?:['’]ll| will)|let me(?: now)?|now,? let me|next,? let me)`;
const PROMISE = new RegExp(String.raw`^(?:${ME}\s+(?:now\s+|just\s+|going to\s+|about to\s+|currently\s+)*(?:prepar|compil|put(?:ting)?\b|writ|draft|gather|finali[sz]|summari[sz]|pull|assembl|format|work(?:ing)? on|get(?:ting)? (?:the|your|that|this)|provid|present|shar|send|deliver|giv)|(?:one moment|stand by|please wait|hang on|working on it|preparing|compiling|drafting|finali[sz]ing)\b)`, "i");

export function isNonAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 160 || /https?:\/\/|\n\s*\n/.test(trimmed)) return false;
  return ACKNOWLEDGEMENT.test(trimmed) || PROMISE.test(trimmed);
}
