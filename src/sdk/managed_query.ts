/**
 * One assistant-message lifecycle wrapping a single SDK Query.
 *
 * Surface to the rest of the app: status (running | success | stopped |
 * error), the final text, the error string, a stop() abort, and a
 * single fin() callback that fires once on terminal. Tool calls and
 * intermediate turns are intentionally not surfaced - the UI shows
 * "Thinking..." then the final text, and that's it.
 *
 * Owns:
 *   - The assistant message row in the DB (insert at construct, update
 *     at terminal)
 *   - The conversation's status + sessionId on terminal
 *   - One SSE message_transition event on terminal
 *
 * If the client is connected when the terminal event fires it sees the
 * SSE event live; if it's not, the DB has the same state and the REST
 * /messages endpoint serves it on reconnect.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { existsSync } from "fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getDb } from "../db/index";
import { conversations, messages } from "../db/schema";
import * as emitter from "../sse/emitter";
import { getAccessToken } from "./auth";

const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Phone-specific CLAUDE.md loaded at startup. Synced from the desktop
 * output style with the "write to disk" delivery rule rewritten for
 * chat-only delivery. Injected via systemPrompt.append so it coexists
 * with project-level CLAUDE.md files in any working directory.
 */
const PHONE_CLAUDE_MD = fs.readFileSync(
  path.join(__dirname, "..", "..", "config", "CLAUDE.md"),
  "utf-8",
);

/**
 * Workaround for SDK variant-selection bug (see docs/SDK_ISSUES.md).
 * On glibc systems where npm installed both linux-x64 and linux-x64-musl
 * optional packages, the SDK's runtime detection sometimes picks the
 * musl binary, which fails to exec on glibc. Force the glibc binary
 * when it's present.
 */
const claudeGlibcBinary = path.resolve(
  __dirname,
  "..",
  "..",
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk-linux-x64",
  "claude",
);
const pathToClaudeCodeExecutable = existsSync(claudeGlibcBinary)
  ? claudeGlibcBinary
  : undefined;

export type Status = "running" | "success" | "stopped" | "error";

export class ManagedQuery {
  status: Status = "running";
  text: string | null = null;
  error: string | null = null;

  readonly id: string;
  readonly conversationId: string;
  private readonly cwd: string;
  private readonly resumeSessionId?: string;
  private readonly abortController = new AbortController();
  private readonly timeoutId: NodeJS.Timeout;
  private finCallback: (() => void) | null = null;

  /** Resolves when the terminal write to DB has landed. */
  readonly done: Promise<void>;

  private constructor(
    id: string,
    conversationId: string,
    cwd: string,
    resumeSessionId: string | undefined,
    prompt: string,
  ) {
    this.id = id;
    this.conversationId = conversationId;
    this.cwd = cwd;
    this.resumeSessionId = resumeSessionId;
    this.timeoutId = setTimeout(() => {
      this.abortController.abort();
    }, PROMPT_TIMEOUT_MS);
    this.done = this.run(prompt).catch((err) => {
      console.error(
        `ManagedQuery internal error for ${conversationId}:${id}:`,
        err,
      );
    });
  }

  /**
   * Create a running ManagedQuery: persist the assistant message row
   * and start driving the SDK Query. The conversation row is assumed to
   * already exist with status='running'.
   */
  static async create(
    conversationId: string,
    cwd: string,
    resumeSessionId: string | undefined,
    prompt: string,
  ): Promise<ManagedQuery> {
    const id = randomUUID();
    await getDb().insert(messages).values({
      id,
      conversationId,
      role: "assistant",
      status: "running",
    });
    return new ManagedQuery(id, conversationId, cwd, resumeSessionId, prompt);
  }

  get inProgress(): boolean {
    return this.status === "running";
  }

  fin(fn: () => void): void {
    if (!this.inProgress) {
      fn();
    } else {
      this.finCallback = fn;
    }
  }

  stop(): void {
    this.abortController.abort();
  }

  private async run(prompt: string): Promise<void> {
    let resultSessionId = this.resumeSessionId ?? "";

    try {
      // Refresh the credentials file if needed before the SDK spawns
      // its CLI subprocess. The CLI reads the file at startup; the
      // SDK's getOAuthToken callback path is gated on an entrypoint
      // allowlist that excludes ours, so we have to refresh here.
      await getAccessToken();

      const options: Record<string, unknown> = {
        cwd: this.cwd,
        abortController: this.abortController,
        permissionMode: "bypassPermissions",
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: PHONE_CLAUDE_MD,
        },
        settingSources: ["project"],
      };

      if (this.resumeSessionId) {
        options.resume = this.resumeSessionId;
      }

      if (pathToClaudeCodeExecutable) {
        options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
      }

      console.log(
        `[mq] starting query conv=${this.conversationId} msg=${this.id} cwd=${this.cwd} hasResume=${!!this.resumeSessionId} hasGlibcPath=${!!pathToClaudeCodeExecutable}`,
      );
      const sdk = query({ prompt, options });

      for await (const event of sdk) {
        if (event.type !== "result") continue;

        const resultEvent = event as {
          subtype?: string;
          result?: string;
          errors?: string[];
          session_id?: string;
        };
        console.log(
          `[mq] result event subtype=${resultEvent.subtype} session_id=${resultEvent.session_id} errors=${JSON.stringify(resultEvent.errors)} resultPreview=${(resultEvent.result ?? "").slice(0, 200)}`,
        );
        if (resultEvent.session_id) {
          resultSessionId = resultEvent.session_id;
        }

        if (resultEvent.subtype === "success") {
          this.text = resultEvent.result ?? "";
          this.status = "success";
        } else {
          this.status = "error";
          this.error =
            (resultEvent.errors ?? []).join("; ") ||
            `result subtype: ${resultEvent.subtype ?? "unknown"}`;
        }
        break;
      }
    } catch (err) {
      console.error(
        `[mq] caught error conv=${this.conversationId} msg=${this.id} aborted=${this.abortController.signal.aborted}:`,
        err,
      );
      if (this.abortController.signal.aborted) {
        this.status = "stopped";
      } else {
        this.status = "error";
        this.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      clearTimeout(this.timeoutId);
      if (this.status === "running") {
        // Iterator ended without a terminal `result` event (defensive).
        this.status = "error";
        this.error = "Query ended without a terminal result event";
      }
      await this.persistTerminal(resultSessionId);
      this.finCallback?.();
    }
  }

  private async persistTerminal(sessionId: string): Promise<void> {
    const finalContent =
      this.status === "success"
        ? this.text ?? ""
        : this.status === "error"
          ? `Error: ${this.error ?? "unknown"}`
          : "(stopped)";

    // By the time persistTerminal runs, this.status is guaranteed not
    // to be "running" (the run() method's finally block ensures it).
    // TS can't track that across the async boundary, so we assert.
    const terminal = this.status as Exclude<Status, "running">;
    const dbStatus: "complete" | "stopped" | "error" =
      terminal === "success" ? "complete" : terminal;

    await getDb()
      .update(messages)
      .set({ status: dbStatus, content: finalContent })
      .where(eq(messages.id, this.id));

    const conversationStatus: "idle" | "stopped" | "error" =
      terminal === "success" ? "idle" : terminal;

    const updates: Record<string, unknown> = { status: conversationStatus };
    if (sessionId) updates.sessionId = sessionId;
    await getDb()
      .update(conversations)
      .set(updates)
      .where(eq(conversations.id, this.conversationId));

    emitter.emit(this.conversationId, {
      type: "message_transition",
      messageId: this.id,
      status: dbStatus,
      content: finalContent,
    });
  }
}
