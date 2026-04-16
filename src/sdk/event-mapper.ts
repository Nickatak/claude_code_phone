/**
 * Translates raw Claude Code SDK streaming events into our simplified
 * event types.
 *
 * The SDK emits fine-grained Anthropic API events (content_block_start,
 * content_block_delta, etc.). We only care about tool lifecycle and the
 * final text - no token-by-token streaming. This mapper extracts just
 * the events the frontend needs.
 */

import type { ToolStartEvent, ToolCompleteEvent } from "../types";

/** Tracks in-flight tool calls so we can accumulate their JSON input. */
export interface ActiveTool {
  name: string;
  input: string;
  toolId: string;
}

let toolCounter = 0;

/**
 * Process a single SDK stream event and return a simplified event if
 * the frontend should know about it, or null to skip.
 */
export function mapSdkEvent(
  sdkEvent: any,
  activeTools: Map<string, ActiveTool>
): ToolStartEvent | ToolCompleteEvent | null {
  if (!sdkEvent || !sdkEvent.type) return null;

  // Tool call starting
  if (
    sdkEvent.type === "content_block_start" &&
    sdkEvent.content_block?.type === "tool_use"
  ) {
    const blockIndex = String(sdkEvent.index);
    const toolId = `tool-${++toolCounter}`;
    activeTools.set(blockIndex, { name: sdkEvent.content_block.name, input: "", toolId });
    return {
      type: "tool_start",
      toolName: sdkEvent.content_block.name,
      toolId,
    };
  }

  // Tool input accumulation (partial JSON deltas)
  if (
    sdkEvent.type === "content_block_delta" &&
    sdkEvent.delta?.type === "input_json_delta"
  ) {
    const blockIndex = String(sdkEvent.index);
    const tool = activeTools.get(blockIndex);
    if (tool) {
      tool.input += sdkEvent.delta.partial_json;
    }
    return null;
  }

  // Tool call finished - emit the complete input
  if (sdkEvent.type === "content_block_stop") {
    const blockIndex = String(sdkEvent.index);
    const tool = activeTools.get(blockIndex);
    if (tool) {
      const event: ToolCompleteEvent = {
        type: "tool_complete",
        toolId: tool.toolId,
        input: tool.input,
      };
      activeTools.delete(blockIndex);
      return event;
    }
  }

  return null;
}
