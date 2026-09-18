import { readFile } from "node:fs/promises";
import { atomicWrite } from "@opencrowd/core";
export interface SteeringMessage { id: string; prompt: string }
export interface SteeringInbox {
  pending(): Promise<SteeringMessage[]>;
  delivered(ids: string[]): Promise<void>;
}
/** Local CLI inbox. Hosted commands use the same loop contract with worker
 * checkpoints as storage. Acknowledgement always follows the loop checkpoint. */
export class FileSteeringInbox implements SteeringInbox {
  private writes = Promise.resolve();
  constructor(private readonly path: string) {}
  private async read(): Promise<SteeringMessage[]> {
    try { return JSON.parse(await readFile(this.path, "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  }
  async pending() { await this.writes; return this.read(); }
  private update(fn: (messages: SteeringMessage[]) => SteeringMessage[]) {
    const write = this.writes.then(async () => atomicWrite(this.path, JSON.stringify(fn(await this.read()))));
    this.writes = write.catch(() => undefined);
    return write;
  }
  push(message: SteeringMessage) { return this.update(messages => messages.some(m => m.id === message.id) ? messages : [...messages, message]); }
  delivered(ids: string[]) { return this.update(messages => messages.filter(m => !ids.includes(m.id))); }
}
