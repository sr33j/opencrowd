import { mkdtemp, mkdir, readFile, rm, symlink, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createSession, loadSession, saveArtifact, readArtifact, resolveAgentPaths, runShell, appendConversationMessage, readConversationEntries, conversationPath } from "../src/index.js";

describe('hosted persistence boundaries',()=>{
  it('recovers only a truncated final journal record and reports the repair',async()=>{
    const root=await mkdtemp(join(tmpdir(),'journal-'));
    try {
      const session=await createSession({workspaceRoot:root});
      await appendConversationMessage(session,{role:'user',content:'keep this'});
      await appendFile(conversationPath(session),' {"type":"message","message":');
      let repairs=0;
      const entries=await readConversationEntries(session,()=>{repairs++;});
      expect(repairs).toBe(1);expect(entries).toHaveLength(1);
      await appendConversationMessage(session,{role:'assistant',content:'still writable'});
      expect(await readConversationEntries(session)).toHaveLength(2);
      await appendFile(conversationPath(session),'corrupt complete record\n');
      await expect(readConversationEntries(session)).rejects.toThrow();
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('rejects traversal and symlinks and relocates session paths on restore',async()=>{
    const root=await mkdtemp(join(tmpdir(),'paths with spaces '));
    try {
      const paths=resolveAgentPaths({agentHome:root});
      const session=await createSession({workspaceRoot:paths.workspace,sessionId:'safe'});
      await expect(createSession({workspaceRoot:root,sessionId:'../escape'})).rejects.toThrow();
      await expect(saveArtifact(session,'../../escape','no')).rejects.toThrow();
      await mkdir(join(root,'outside'));
      await symlink(join(root,'outside'),join(session.artifactsDir,'link'));
      await expect(saveArtifact(session,'link/escape','no')).rejects.toThrow('symlink');
      await saveArtifact(session,'report.md','durable');
      expect(await readArtifact(session,'report.md')).toBe('durable');
      const {cp}=await import('node:fs/promises');
      await cp(paths.workspace,join(root,'restored'),{recursive:true});
      const restored=await loadSession(join(root,'restored'),'safe');
      expect(restored.sessionDir).toBe(join(root,'restored/sessions/safe'));
      expect(await readArtifact(restored,'report.md')).toBe('durable');
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('cancels a shell process group before its delayed side effect',async()=>{
    const root=await mkdtemp(join(tmpdir(),'shell-cancel-'));
    try {
      const session=await createSession({workspaceRoot:root,shellEnabled:true});
      const controller=new AbortController();
      const task=runShell(session,'sleep 1; echo leaked > cancelled-output',root,5000,{signal:controller.signal});
      setTimeout(()=>controller.abort(),30);
      const result=await task;
      expect(result.exit_code).not.toBe(0);
      await expect(readFile(join(root,'cancelled-output'))).rejects.toThrow();
    } finally {await rm(root,{recursive:true,force:true});}
  });
});
