import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * ManagedQuery wraps one SDK query() invocation. Exposes only what the
 * UI needs: in-progress flag, final text, error, and abort. Tool calls
 * and intermediate turns are intentionally not surfaced.
 */
export class ManagedQuery {
  constructor(prompt) {
    this.status = "in_progress";
    this.text = null;
    this.error = null;
    this._abort_controller = new AbortController();
    this._fin = null;
    this._run(prompt);
  }

  get in_progress() {
    return this.status === "in_progress";
  }

  callback_fin(fn) {
    if (!this.in_progress) {
      fn();
    } else {
      this._fin = fn;
    }
  }

  stop() {
    this._abort_controller.abort();
  }

  async _run(prompt) {
    try {
      const sdk = query({
        prompt,
        options: {
          abortController: this._abort_controller,
          permissionMode: "bypassPermissions",
          settingSources: [],
        },
      });

      for await (const event of sdk) {
        if (event.type !== "result") continue;
        if (event.subtype === "success") {
          this.status = "success";
          this.text = event.result;
        } else {
          this.status = "error";
          this.error =
            (event.errors ?? []).join("; ") ||
            `result subtype: ${event.subtype}`;
        }
        break;
      }
    } catch (e) {
      if (this._abort_controller.signal.aborted) {
        this.status = "stopped";
      } else {
        this.status = "error";
        this.error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      if (this.status === "in_progress") {
        this.status = "error";
        this.error = "Query ended without a terminal result event";
      }
      if (this._fin) this._fin();
    }
  }
}
