/**
 * Tests for MessageSession - the assistant-message FSM.
 *
 * These tests hit a real Postgres (the dev DB at localhost:5433 -
 * `make db-up` brings it up). Each test starts with truncated tables
 * and a fresh parent conversation. The pool is closed once at the end
 * so the test process exits cleanly.
 *
 * Prerequisite: `make db-up` and DATABASE_URL set (the npm test script
 * loads .env via Node's --env-file flag).
 */

import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { closeDb, getDb, runMigrations } from "../src/db/index";
import { conversations, messages, toolEvents } from "../src/db/schema";
import { MessageSession } from "../src/sdk/message-session";
import * as emitter from "../src/sse/emitter";
import type { SSEEvent } from "../src/sse/types";

let convId: string;
let captured: SSEEvent[];
let unsub: () => void;

before(async () => {
  // Make sure the schema is current. Idempotent if already applied.
  await runMigrations();
});

beforeEach(async () => {
  const db = getDb();
  // FK order: tool_events -> messages -> conversations
  await db.delete(toolEvents);
  await db.delete(messages);
  await db.delete(conversations);

  convId = randomUUID();
  await db.insert(conversations).values({
    id: convId,
    cwd: "/tmp",
    status: "running",
  });

  captured = [];
  unsub = emitter.subscribe(convId, (event) => captured.push(event));
});

afterEach(() => {
  if (unsub) unsub();
});

after(async () => {
  await closeDb();
});

describe("MessageSession - creation", () => {
  it("inserts a running assistant message with null content", async () => {
    const session = await MessageSession.create(convId);
    const rows = await getDb().select().from(messages).where(eq(messages.id, session.id));

    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, "assistant");
    assert.equal(rows[0].status, "running");
    assert.equal(rows[0].content, null);
    assert.equal(rows[0].conversationId, convId);
  });

  it("emits no SSE events on creation", async () => {
    await MessageSession.create(convId);
    assert.deepEqual(captured, []);
  });
});

describe("MessageSession - content accumulation", () => {
  it("appendContent stays in memory; DB content is null until terminal", async () => {
    const session = await MessageSession.create(convId);
    session.appendContent("hello ");
    session.appendContent("world");

    const rows = await getDb().select().from(messages).where(eq(messages.id, session.id));
    assert.equal(rows[0].content, null);
  });
});

describe("MessageSession - terminal: complete", () => {
  it("writes accumulated content, marks complete, updates conversation idle/sessionId", async () => {
    const session = await MessageSession.create(convId);
    session.appendContent("the answer");
    await session.complete("sdk-session-123");

    const msgRows = await getDb().select().from(messages).where(eq(messages.id, session.id));
    assert.equal(msgRows[0].status, "complete");
    assert.equal(msgRows[0].content, "the answer");

    const convRows = await getDb().select().from(conversations).where(eq(conversations.id, convId));
    assert.equal(convRows[0].status, "idle");
    assert.equal(convRows[0].sessionId, "sdk-session-123");
  });

  it("emits a single message_transition event with the final content", async () => {
    const session = await MessageSession.create(convId);
    session.appendContent("the answer");
    await session.complete("sid");

    const transitions = captured.filter((e) => e.type === "message_transition");
    assert.equal(transitions.length, 1);
    assert.deepEqual(transitions[0], {
      type: "message_transition",
      messageId: session.id,
      status: "complete",
      content: "the answer",
    });
  });
});

describe("MessageSession - terminal: stop", () => {
  it("keeps accumulated text and marks the conversation stopped", async () => {
    const session = await MessageSession.create(convId);
    session.appendContent("partial");
    await session.stop();

    const msgRows = await getDb().select().from(messages).where(eq(messages.id, session.id));
    assert.equal(msgRows[0].status, "stopped");
    assert.equal(msgRows[0].content, "partial");

    const convRows = await getDb().select().from(conversations).where(eq(conversations.id, convId));
    assert.equal(convRows[0].status, "stopped");
  });

  it("uses '(stopped)' placeholder when no content accumulated", async () => {
    const session = await MessageSession.create(convId);
    await session.stop();

    const msgRows = await getDb().select().from(messages).where(eq(messages.id, session.id));
    assert.equal(msgRows[0].content, "(stopped)");
  });
});

describe("MessageSession - terminal: fail", () => {
  it("stores 'Error: <message>' and marks conversation error", async () => {
    const session = await MessageSession.create(convId);
    await session.fail(new Error("boom"));

    const msgRows = await getDb().select().from(messages).where(eq(messages.id, session.id));
    assert.equal(msgRows[0].status, "error");
    assert.equal(msgRows[0].content, "Error: boom");

    const convRows = await getDb().select().from(conversations).where(eq(conversations.id, convId));
    assert.equal(convRows[0].status, "error");
  });

  it("accepts a string error too", async () => {
    const session = await MessageSession.create(convId);
    await session.fail("plain string");

    const msgRows = await getDb().select().from(messages).where(eq(messages.id, session.id));
    assert.equal(msgRows[0].content, "Error: plain string");
  });
});

describe("MessageSession - tool events", () => {
  it("toolStarted inserts a tool_event tied to the parent message", async () => {
    const session = await MessageSession.create(convId);
    await session.toolStarted("Read", "tool-1");

    const rows = await getDb().select().from(toolEvents);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].messageId, session.id);
    assert.equal(rows[0].toolName, "Read");
    assert.equal(rows[0].toolId, "tool-1");
    assert.equal(rows[0].status, "running");
    assert.equal(rows[0].input, null);
  });

  it("toolStarted emits tool_start with messageId", async () => {
    const session = await MessageSession.create(convId);
    await session.toolStarted("Read", "tool-1");

    const events = captured.filter((e) => e.type === "tool_start");
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      type: "tool_start",
      messageId: session.id,
      toolName: "Read",
      toolId: "tool-1",
    });
  });

  it("toolCompleted updates input + status and emits tool_complete", async () => {
    const session = await MessageSession.create(convId);
    await session.toolStarted("Bash", "tool-2");
    await session.toolCompleted("tool-2", '{"command":"ls"}');

    const rows = await getDb().select().from(toolEvents);
    assert.equal(rows[0].status, "complete");
    assert.equal(rows[0].input, '{"command":"ls"}');

    const completes = captured.filter((e) => e.type === "tool_complete");
    assert.equal(completes.length, 1);
    assert.deepEqual(completes[0], {
      type: "tool_complete",
      messageId: session.id,
      toolId: "tool-2",
      input: '{"command":"ls"}',
    });
  });

  it("supports multiple tool events on a single session", async () => {
    const session = await MessageSession.create(convId);
    await session.toolStarted("A", "id-1");
    await session.toolStarted("B", "id-2");
    await session.toolCompleted("id-1", "input1");
    await session.toolCompleted("id-2", "input2");

    const rows = await getDb().select().from(toolEvents);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === "complete"));
    assert.ok(rows.every((r) => r.messageId === session.id));
  });
});

describe("MessageSession - state-machine enforcement", () => {
  it("complete after complete throws", async () => {
    const session = await MessageSession.create(convId);
    await session.complete("sid");
    await assert.rejects(
      () => session.complete("sid"),
      /cannot transition to complete from complete/,
    );
  });

  it("stop after complete throws", async () => {
    const session = await MessageSession.create(convId);
    await session.complete("sid");
    await assert.rejects(
      () => session.stop(),
      /cannot transition to stopped from complete/,
    );
  });

  it("appendContent after terminal throws", async () => {
    const session = await MessageSession.create(convId);
    await session.complete("sid");
    assert.throws(
      () => session.appendContent("more"),
      /appendContent called after terminal/,
    );
  });

  it("toolStarted after terminal throws", async () => {
    const session = await MessageSession.create(convId);
    await session.complete("sid");
    await assert.rejects(
      () => session.toolStarted("X", "id"),
      /toolStarted called after terminal/,
    );
  });
});
