import type { StreamEvent } from "../types";

/**
 * Translate raw Anthropic API streaming events into our simplified
 * StreamEvent protocol that the frontend knows how to render.
 */
export function mapSdkEvent(
  sdkEvent: any,
  activeTools: Map<string, { name: string; input: string }>
): StreamEvent | null {
  if (!sdkEvent || !sdkEvent.type) return null;

  if (sdkEvent.type === "content_block_delta") {
    // Text chunk from Claude's response
    if (sdkEvent.delta?.type === "text_delta") {
      return { type: "text_delta", text: sdkEvent.delta.text };
    }
    // Partial JSON for a tool call's input (streamed incrementally)
    if (sdkEvent.delta?.type === "input_json_delta") {
      const toolId = String(sdkEvent.index);
      const tool = activeTools.get(toolId);
      if (tool) {
        tool.input += sdkEvent.delta.partial_json;
      }
      return {
        type: "tool_input",
        toolId,
        partialInput: sdkEvent.delta.partial_json,
      };
    }
  }

  // Claude is starting a new tool call
  if (
    sdkEvent.type === "content_block_start" &&
    sdkEvent.content_block?.type === "tool_use"
  ) {
    const toolId = String(sdkEvent.index);
    activeTools.set(toolId, {
      name: sdkEvent.content_block.name,
      input: "",
    });
    return {
      type: "tool_start",
      toolName: sdkEvent.content_block.name,
      toolId,
    };
  }

  // A content block (tool call) has finished
  if (sdkEvent.type === "content_block_stop") {
    const toolId = String(sdkEvent.index);
    const tool = activeTools.get(toolId);
    if (tool) {
      return {
        type: "tool_result",
        toolId,
        result: tool.input,
      };
    }
  }

  return null;
}
