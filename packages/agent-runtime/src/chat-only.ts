import type { LlmMessage } from "./index.js";

/**
 * Chat-only hosted runs.
 *
 * Some models can hold a conversation but cannot be trusted with tools: given
 * `run_shell`, `venice-uncensored-1-2` wrote the call out as text and then
 * made up what the command printed. The host marks such a model chat-only
 * (`modelPolicy.chatOnly`), and its runs get no tools at all: no tool
 * definitions on the wire, no tool-use instructions in the prompt, and no tool
 * call executed even if the seller returns one. What the model is told
 * instead is what it can do, and what to say when it is asked for more.
 */
export const CHAT_ONLY_SYSTEM_PROMPT = [
  "You are a hosted CrowdCode agent, talking with your owner.",
  "This agent runs on a chat-only model: in this chat you have no tools. You cannot run commands or code, read, write or send files, browse or search the web, buy or call paid services, send email or messages, schedule reminders or recurring tasks, or move money.",
  "Talk with the owner: answer questions, explain, write, brainstorm, and take part in role-play or creative writing when they ask for it, from your own knowledge.",
  "When the owner asks for something that needs one of those abilities, say plainly that this agent is on a chat-only model and cannot do it, suggest switching this agent to a model that can use tools in the model picker, and offer what you can do in words instead.",
  "Never pretend to have done such a thing: do not write out a tool or function call, and never invent command output, search results, file contents, prices, or payment, booking or delivery confirmations.",
  "You cannot check anything live, so say so when an answer depends on current facts.",
].join(" ") + "\n\n" + [
  // Last and on its own, because it is the rule the models broke: asked for a
  // SHA-256, venice-uncensored-role-play said it could not compute one and then
  // gave "the first 12 characters" anyway, in 3 of 12 tries with the rules
  // above and 0 of 24 with this one (2026-11-06). "Exact results" alone made
  // it refuse 17 × 23, hence the last sentence.
  "Most important rule: you cannot compute a hash, checksum or encoding, or know what a command, a file or a live lookup would return, so never write one down: not a guess, not an example, not \"the first few characters\".",
  "Any value you wrote would be made up, and the owner would act on it. Say you cannot produce it, and stop there.",
  "Ordinary arithmetic and facts you know are fine to answer.",
].join(" ");

/**
 * The conversation as a chat-only model is sent it.
 *
 * A chat can change model: an owner who worked with a tool-using model and
 * then picks a chat-only one has a history full of tool calls and results.
 * Sent without tool definitions, that history is one some sellers refuse and
 * that invites the model to imitate the calls, so the request carries only
 * what was said: tool results are left out, and an assistant turn keeps its
 * words and loses its calls. The stored history is not touched, so switching
 * back to a tool-using model loses nothing.
 */
export function chatOnlyMessages<T extends Pick<LlmMessage, "role" | "content" | "toolCalls" | "toolCallId">>(messages: T[]): T[] {
  return messages.flatMap((message) => {
    if (message.role === "tool") return [];
    if (message.role !== "assistant" || !message.toolCalls?.length) return [message];
    if (!message.content.trim()) return [];
    const { toolCalls: _calls, ...rest } = message;
    return [rest as T];
  });
}
