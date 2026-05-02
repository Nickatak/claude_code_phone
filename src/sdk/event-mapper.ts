/**
 * Translates raw Claude Code SDK streaming events into simplified
 * event types for the frontend.
 *
 * The SDK emits fine-grained Anthropic API events (content_block_start,
 * content_block_delta, etc.). We only care about tool lifecycle and the
 * final text - no token-by-token streaming. This class extracts just
 * the events the frontend needs.
 *
 * Each instance tracks its own in-flight tool calls, so one EventMapper
 * per prompt execution. The globally incrementing tool ID counter
 * prevents DOM collisions when the SDK resets content block indices
 * across turns.
 */

/** Simplified tool lifecycle events extracted from raw SDK stream events. */
export interface MappedToolStart {
  type: "tool_start";
  toolName: string;
  toolId: string;
}

export interface MappedToolComplete {
  type: "tool_complete";
  toolId: string;
  input: string;
}

export type MappedSDKEvent = MappedToolStart | MappedToolComplete;

/** In-flight tool call being accumulated from streaming deltas. */
interface ActiveTool {
  name: string;
  input: string;
  toolId: string;
}

let toolCounter = 0;

export class EventMapper {
  /** Maps content block index -> in-flight tool call. */
  private activeTools = new Map<string, ActiveTool>();

  /**
   * Process a single SDK stream event and return a simplified event if
   * the caller should know about it, or null to skip.
   */
  map(sdkEvent: any): MappedSDKEvent | null {
    if (!sdkEvent || !sdkEvent.type) return null;

    // Tool call starting
    if (
      sdkEvent.type === "content_block_start" &&
      sdkEvent.content_block?.type === "tool_use"
    ) {
      const blockIndex = String(sdkEvent.index);
      const toolId = `tool-${++toolCounter}`;
      this.activeTools.set(blockIndex, {
        name: sdkEvent.content_block.name,
        input: "",
        toolId,
      });
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
      const tool = this.activeTools.get(blockIndex);
      if (tool) {
        tool.input += sdkEvent.delta.partial_json;
      }
      return null;
    }

    // Tool call finished - emit the complete input
    if (sdkEvent.type === "content_block_stop") {
      const blockIndex = String(sdkEvent.index);
      const tool = this.activeTools.get(blockIndex);
      if (tool) {
        const event: MappedToolComplete = {
          type: "tool_complete",
          toolId: tool.toolId,
          input: tool.input,
        };
        this.activeTools.delete(blockIndex);
        return event;
      }
    }

    return null;
  }
}
