/**
 * Tests for the EventMapper class.
 *
 * EventMapper translates raw Anthropic streaming events into the
 * simplified tool lifecycle events the frontend needs. These tests
 * verify correct mapping, state tracking, and the fix for tool ID
 * collisions across SDK turns.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventMapper } from "../src/sdk/event-mapper";

/** Helper: build a content_block_start event for a tool_use block. */
function toolStart(index: number, name: string) {
  return {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", name },
  };
}

/** Helper: build an input_json_delta event. */
function inputDelta(index: number, partialJson: string) {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  };
}

/** Helper: build a content_block_stop event. */
function blockStop(index: number) {
  return { type: "content_block_stop", index };
}

/** Helper: build a text_delta event. */
function textDelta(index: number, text: string) {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  };
}

describe("EventMapper", () => {
  let mapper: EventMapper;

  beforeEach(() => {
    mapper = new EventMapper();
  });

  it("returns null for null/undefined/empty events", () => {
    assert.equal(mapper.map(null), null);
    assert.equal(mapper.map(undefined), null);
    assert.equal(mapper.map({}), null);
    assert.equal(mapper.map({ type: "message_start" }), null);
  });

  it("emits tool_start on content_block_start with tool_use", () => {
    const result = mapper.map(toolStart(0, "Bash"));

    assert.equal(result?.type, "tool_start");
    assert.equal(result?.toolName, "Bash");
    assert.ok(result?.toolId);
  });

  it("accumulates input deltas and emits tool_complete on block stop", () => {
    mapper.map(toolStart(0, "Read"));

    // Input arrives in chunks
    assert.equal(mapper.map(inputDelta(0, '{"file')), null);
    assert.equal(mapper.map(inputDelta(0, '":"foo.ts"}')), null);

    const result = mapper.map(blockStop(0));

    assert.equal(result?.type, "tool_complete");
    assert.equal(result?.input, '{"file":"foo.ts"}');
  });

  it("ignores text deltas", () => {
    assert.equal(mapper.map(textDelta(0, "Hello")), null);
  });

  it("tracks multiple concurrent tool calls by block index", () => {
    const start0 = mapper.map(toolStart(0, "Bash"));
    const start1 = mapper.map(toolStart(1, "Read"));

    mapper.map(inputDelta(0, '{"command":"ls"}'));
    mapper.map(inputDelta(1, '{"file":"bar.ts"}'));

    const complete0 = mapper.map(blockStop(0));
    const complete1 = mapper.map(blockStop(1));

    assert.equal(complete0?.input, '{"command":"ls"}');
    assert.equal(complete1?.input, '{"file":"bar.ts"}');

    // Verify they got different tool IDs
    assert.notEqual(start0?.toolId, start1?.toolId);
    assert.equal(start0?.toolId, complete0?.toolId);
    assert.equal(start1?.toolId, complete1?.toolId);
  });

  it("assigns unique tool IDs across turns (index reuse)", () => {
    // Turn 1: tool at index 0
    const turn1Start = mapper.map(toolStart(0, "Bash"));
    mapper.map(inputDelta(0, '{"command":"pwd"}'));
    const turn1Complete = mapper.map(blockStop(0));

    // Turn 2: another tool at index 0 (SDK resets indices per response)
    const turn2Start = mapper.map(toolStart(0, "Read"));
    mapper.map(inputDelta(0, '{"file":"src/server.ts"}'));
    const turn2Complete = mapper.map(blockStop(0));

    // Both turns should have different tool IDs
    assert.notEqual(turn1Start?.toolId, turn2Start?.toolId);
    assert.equal(turn1Start?.toolId, turn1Complete?.toolId);
    assert.equal(turn2Start?.toolId, turn2Complete?.toolId);
  });

  it("returns null for block stop with no matching start", () => {
    assert.equal(mapper.map(blockStop(99)), null);
  });

  it("returns null for input delta with no matching start", () => {
    assert.equal(mapper.map(inputDelta(5, '{"orphan":true}')), null);
  });

  it("handles tool with empty input", () => {
    mapper.map(toolStart(0, "Bash"));
    const result = mapper.map(blockStop(0));

    assert.equal(result?.type, "tool_complete");
    assert.equal(result?.input, "");
  });
});
