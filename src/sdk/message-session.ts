/**
 * One assistant-message lifecycle, owned end-to-end.
 *
 * Created when the SDK starts producing output for a prompt, then driven
 * forward by callers (the process-manager) until it reaches a terminal
 * state. Owns the message row in the DB, its tool_events children, and
 * the conversation's status field. Each transition writes to the DB and
 * emits the corresponding SSE event.
 *
 * State machine:
 *
 *     ┌─→ complete   (SDK finished cleanly)
 *     ├─→ stopped    (caller aborted; partial content kept)
 *     └─→ error      (SDK threw; error message stored as content)
 *
 *   running ──── (one of the above) ────→ terminal
 *
 * Content is held in memory while running and only persisted on the
 * terminal write. Reading a running message via REST returns
 * content=NULL, status=running - the client renders that as "still
 * working" without needing partial text. This is intentional: it
 * eliminates the class of bugs where DB content, in-memory accumulator,
 * and SSE emissions can drift out of sync.
 */

import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { conversations, messages, toolEvents } from "../db/schema";
import * as emitter from "../sse/emitter";

type Status = "running" | "complete" | "stopped" | "error";
type TerminalStatus = Exclude<Status, "running">;

export class MessageSession {
  private status: Status = "running";
  private content = "";

  private constructor(
    public readonly id: string,
    public readonly conversationId: string,
  ) {}

  /**
   * Create a new running assistant message and persist it.
   * The conversation row is assumed to already exist with status='running'.
   */
  static async create(conversationId: string): Promise<MessageSession> {
    const id = randomUUID();
    await getDb().insert(messages).values({
      id,
      conversationId,
      role: "assistant",
      status: "running",
    });
    return new MessageSession(id, conversationId);
  }

  /** Append a text delta to the in-memory accumulator. Not persisted until terminal. */
  appendContent(delta: string): void {
    this.assertRunning("appendContent");
    this.content += delta;
  }

  /** Record that a tool started running. Persists the tool_event row. */
  async toolStarted(toolName: string, toolId: string): Promise<void> {
    this.assertRunning("toolStarted");
    await getDb().insert(toolEvents).values({
      conversationId: this.conversationId,
      messageId: this.id,
      toolName,
      toolId,
      status: "running",
    });
    emitter.emit(this.conversationId, {
      type: "tool_start",
      messageId: this.id,
      toolName,
      toolId,
    });
  }

  /** Record that a tool completed. Updates the tool_event row by toolId. */
  async toolCompleted(toolId: string, input: string): Promise<void> {
    this.assertRunning("toolCompleted");
    await getDb().update(toolEvents)
      .set({ input, status: "complete" })
      .where(and(
        eq(toolEvents.toolId, toolId),
        eq(toolEvents.messageId, this.id),
      ));
    emitter.emit(this.conversationId, {
      type: "tool_complete",
      messageId: this.id,
      toolId,
      input,
    });
  }

  /**
   * Terminal: SDK finished cleanly.
   * Persists final content, marks message complete, sets the conversation
   * back to idle and stamps the SDK session ID for future resumption.
   */
  async complete(sessionId: string): Promise<void> {
    await this.transitionTerminal("complete", this.content);
    await getDb().update(conversations)
      .set({ status: "idle", sessionId })
      .where(eq(conversations.id, this.conversationId));
  }

  /**
   * Terminal: caller aborted.
   * Whatever text has accumulated is kept as content; if none, "(stopped)".
   */
  async stop(): Promise<void> {
    const finalContent = this.content || "(stopped)";
    await this.transitionTerminal("stopped", finalContent);
    await getDb().update(conversations)
      .set({ status: "stopped" })
      .where(eq(conversations.id, this.conversationId));
  }

  /** Terminal: SDK threw. The error message becomes the message content. */
  async fail(error: Error | string): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.transitionTerminal("error", `Error: ${message}`);
    await getDb().update(conversations)
      .set({ status: "error" })
      .where(eq(conversations.id, this.conversationId));
  }

  private async transitionTerminal(
    to: TerminalStatus,
    finalContent: string,
  ): Promise<void> {
    if (this.status !== "running") {
      throw new Error(
        `MessageSession cannot transition to ${to} from ${this.status}`,
      );
    }
    this.status = to;
    await getDb().update(messages)
      .set({ status: to, content: finalContent })
      .where(eq(messages.id, this.id));
    emitter.emit(this.conversationId, {
      type: "message_transition",
      messageId: this.id,
      status: to,
      content: finalContent,
    });
  }

  private assertRunning(method: string): void {
    if (this.status !== "running") {
      throw new Error(
        `MessageSession.${method} called after terminal transition (${this.status})`,
      );
    }
  }
}
