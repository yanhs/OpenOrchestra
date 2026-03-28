/**
 * Claude Agent SDK StreamFn implementation.
 *
 * Bridges @anthropic-ai/claude-agent-sdk (subscription-based, spawns Claude CLI)
 * to OpenClaw's AssistantMessageEventStream interface.
 *
 * Key difference from API providers: the Agent SDK spawns a local Claude Code
 * process that authenticates via the user's Pro/Max subscription — no API key needed.
 */

import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ToolCall,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime";

const log = createSubsystemLogger("claude-sdk-stream");

// ── Helpers ──────────────────────────────────────────────────────────────────

type StreamModelDescriptor = { api: string; provider: string; id: string };

function buildUsageFromSdkResult(result: {
  usage?: { input_tokens?: number; output_tokens?: number };
  total_cost_usd?: number;
}): Usage {
  const input = result.usage?.input_tokens ?? 0;
  const output = result.usage?.output_tokens ?? 0;
  const cost = result.total_cost_usd ?? 0;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function buildUsageEmpty(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function buildAssistantMsg(params: {
  model: StreamModelDescriptor;
  content: AssistantMessage["content"];
  stopReason: StopReason;
  usage: Usage;
}): AssistantMessage {
  return {
    role: "assistant",
    content: params.content,
    stopReason: params.stopReason,
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: params.usage,
    timestamp: Date.now(),
  };
}

function buildErrorMsg(params: {
  model: StreamModelDescriptor;
  errorMessage: string;
}): AssistantMessage & { stopReason: "error"; errorMessage: string } {
  return {
    ...buildAssistantMsg({
      model: params.model,
      content: [],
      stopReason: "error",
      usage: buildUsageEmpty(),
    }),
    stopReason: "error",
    errorMessage: params.errorMessage,
  };
}

// ── Message conversion ───────────────────────────────────────────────────────

/**
 * Convert OpenClaw conversation messages to a text prompt for the Agent SDK.
 * The SDK works as a full agent — it takes a string prompt, not structured messages.
 * We serialize the conversation history into a coherent prompt.
 */
function convertMessagesToPrompt(
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt?: string,
): string {
  const parts: string[] = [];

  if (systemPrompt) {
    parts.push(systemPrompt);
    parts.push("");
  }

  // Take only the last user message as the direct prompt.
  // The Agent SDK manages its own session history internally.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        parts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "string") {
            parts.push(block);
          } else if (block && typeof block === "object" && "text" in block) {
            parts.push(String((block as { text: string }).text));
          }
        }
      }
      break;
    }
  }

  return parts.join("\n");
}

// ── SDK streaming event → OpenClaw event bridge ──────────────────────────────

/**
 * Process BetaRawMessageStreamEvent from the Agent SDK's partial messages
 * and push corresponding events into the OpenClaw stream.
 */
function handleStreamEvent(
  event: {
    type: string;
    index?: number;
    delta?: { type?: string; text?: string; partial_json?: string };
    content_block?: { type?: string; id?: string; name?: string; text?: string };
  },
  state: {
    accumulatedText: string;
    textBlockOpen: boolean;
    toolCalls: ToolCall[];
    currentToolIndex: number;
    currentToolJson: string;
  },
  modelInfo: StreamModelDescriptor,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
): void {
  switch (event.type) {
    case "message_start": {
      const emptyPartial = buildAssistantMsg({
        model: modelInfo,
        content: [],
        stopReason: "stop",
        usage: buildUsageEmpty(),
      });
      stream.push({ type: "start", partial: emptyPartial });
      break;
    }

    case "content_block_start": {
      const block = event.content_block;
      if (block?.type === "text") {
        state.textBlockOpen = true;
        const partial = buildAssistantMsg({
          model: modelInfo,
          content: [],
          stopReason: "stop",
          usage: buildUsageEmpty(),
        });
        stream.push({ type: "text_start", contentIndex: event.index ?? 0, partial });
      } else if (block?.type === "tool_use") {
        state.currentToolIndex = state.toolCalls.length;
        state.currentToolJson = "";
      }
      break;
    }

    case "content_block_delta": {
      const delta = event.delta;
      if (delta?.type === "text_delta" && delta.text) {
        state.accumulatedText += delta.text;
        const partial = buildAssistantMsg({
          model: modelInfo,
          content: [{ type: "text", text: state.accumulatedText }],
          stopReason: "stop",
          usage: buildUsageEmpty(),
        });
        stream.push({
          type: "text_delta",
          contentIndex: event.index ?? 0,
          delta: delta.text,
          partial,
        });
      } else if (delta?.type === "input_json_delta" && delta.partial_json) {
        state.currentToolJson += delta.partial_json;
      }
      break;
    }

    case "content_block_stop": {
      if (state.textBlockOpen) {
        state.textBlockOpen = false;
        const partial = buildAssistantMsg({
          model: modelInfo,
          content: [{ type: "text", text: state.accumulatedText }],
          stopReason: "stop",
          usage: buildUsageEmpty(),
        });
        stream.push({
          type: "text_end",
          contentIndex: event.index ?? 0,
          content: state.accumulatedText,
          partial,
        });
      }
      break;
    }

    default:
      break;
  }
}

// ── Main StreamFn factory ────────────────────────────────────────────────────

export interface ClaudeSdkStreamOptions {
  /** Path to Claude CLI binary. Auto-detected if omitted. */
  cliPath?: string;
  /** Working directory for the Claude session. */
  cwd?: string;
  /** Permission mode for tool execution. Default: "bypassPermissions". */
  permissionMode?: string;
  /** Maximum turns for the agent. */
  maxTurns?: number;
  /** Session ID for resume. */
  sessionId?: string;
}

export function createClaudeSdkStreamFn(opts: ClaudeSdkStreamOptions = {}): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      const stderrLines: string[] = [];
      try {
        // Dynamic import to avoid loading the heavy SDK bundle eagerly
        const sdk = await import("@anthropic-ai/claude-agent-sdk");

        const prompt = convertMessagesToPrompt(
          (context.messages ?? []) as Array<{ role: string; content: unknown }>,
          context.systemPrompt,
        );

        if (!prompt.trim()) {
          throw new Error("Empty prompt — nothing to send to Claude SDK");
        }

        const modelInfo: StreamModelDescriptor = {
          api: "claude-sdk",
          provider: "claude-sdk",
          id: model.id,
        };

        // Resolve model alias for Claude CLI
        const modelId = resolveClaudeModel(model.id);

        // Build SDK options — resolve cwd from options, env, or process.cwd()
        const resolvedCwd =
          opts.cwd ??
          process.env.OPENCLAW_WORKSPACE ??
          (process.env.HOME ? `${process.env.HOME}/.openclaw/workspace` : process.cwd());

        // Resolve the Claude CLI path — needed when running from bundled dist
        const { execSync } = await import("node:child_process");
        let claudePath: string | undefined;
        try {
          claudePath = execSync("which claude", { encoding: "utf8" }).trim();
        } catch {
          // Fallback: try well-known paths
          const wellKnown = [`${process.env.HOME}/.local/bin/claude`, "/usr/local/bin/claude"];
          const fsMod = await import("node:fs");
          claudePath = wellKnown.find((p) => fsMod.existsSync(p));
        }

        const sdkOptions: Parameters<typeof sdk.query>[0]["options"] = {
          cwd: resolvedCwd,
          includePartialMessages: true,
          model: modelId,
          permissionMode: (opts.permissionMode ?? "bypassPermissions") as "bypassPermissions",
          maxTurns: opts.maxTurns ?? 200,
          persistSession: true,
          ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
        };

        if (opts.sessionId) {
          sdkOptions.resume = opts.sessionId;
        }

        if (options?.signal) {
          const ac = new AbortController();
          options.signal.addEventListener("abort", () => ac.abort(), { once: true });
          sdkOptions.abortController = ac;
        }

        // Ensure cwd exists
        const fs = await import("node:fs");
        if (!fs.existsSync(resolvedCwd)) {
          fs.mkdirSync(resolvedCwd, { recursive: true });
        }

        // Pass env through to the SDK so it inherits PATH etc.
        // Also capture stderr for debugging
        sdkOptions.env = { ...process.env };
        // @ts-expect-error — stderr callback supported but not in all type defs
        sdkOptions.stderr = (line: string) => {
          stderrLines.push(line);
          if (stderrLines.length <= 5) {
            log.info("Claude CLI stderr", { line });
          }
        };

        log.info("Starting Claude SDK query", {
          model: modelId,
          cwd: resolvedCwd,
          cwdExists: fs.existsSync(resolvedCwd),
          prompt: prompt.slice(0, 100),
          path: process.env.PATH?.split(":").slice(0, 3).join(":"),
        });

        // State for accumulating the streaming response
        const state = {
          accumulatedText: "",
          textBlockOpen: false,
          toolCalls: [] as ToolCall[],
          currentToolIndex: 0,
          currentToolJson: "",
        };

        let resultUsage: Usage = buildUsageEmpty();
        let gotResult = false;

        const queryIter = sdk.query({ prompt, options: sdkOptions });

        for await (const message of queryIter) {
          switch (message.type) {
            case "stream_event": {
              // SDKPartialAssistantMessage — contains BetaRawMessageStreamEvent
              const event = (message as unknown as { event: Record<string, unknown> }).event;
              handleStreamEvent(
                event as Parameters<typeof handleStreamEvent>[0],
                state,
                modelInfo,
                stream,
              );
              break;
            }

            case "assistant": {
              // SDKAssistantMessage — full assistant message with BetaMessage
              // Extract text content from the full message for final assembly
              const betaMsg = (message as { message: { content: unknown[] } }).message;
              if (betaMsg?.content && Array.isArray(betaMsg.content)) {
                for (const block of betaMsg.content) {
                  const b = block as { type: string; text?: string; id?: string; name?: string; input?: unknown };
                  if (b.type === "text" && b.text && !state.accumulatedText) {
                    state.accumulatedText = b.text;
                  } else if (b.type === "tool_use" && b.name) {
                    state.toolCalls.push({
                      type: "toolCall",
                      id: b.id ?? randomUUID(),
                      name: b.name,
                      arguments:
                        b.input && typeof b.input === "object"
                          ? (b.input as Record<string, unknown>)
                          : {},
                    });
                  }
                }
              }
              break;
            }

            case "result": {
              // SDKResultMessage — final result with cost and usage
              const result = message as {
                subtype: string;
                result?: string;
                total_cost_usd?: number;
                usage?: { input_tokens?: number; output_tokens?: number };
                session_id?: string;
              };

              gotResult = true;

              if (result.subtype === "success") {
                resultUsage = buildUsageFromSdkResult(result);

                // If we didn't get streaming text, use the result text
                if (!state.accumulatedText && result.result) {
                  state.accumulatedText = result.result;

                  // Emit text events for the final result
                  const emptyPartial = buildAssistantMsg({
                    model: modelInfo,
                    content: [],
                    stopReason: "stop",
                    usage: resultUsage,
                  });
                  stream.push({ type: "start", partial: emptyPartial });
                  stream.push({ type: "text_start", contentIndex: 0, partial: emptyPartial });
                  stream.push({
                    type: "text_delta",
                    contentIndex: 0,
                    delta: state.accumulatedText,
                    partial: buildAssistantMsg({
                      model: modelInfo,
                      content: [{ type: "text", text: state.accumulatedText }],
                      stopReason: "stop",
                      usage: resultUsage,
                    }),
                  });
                  stream.push({
                    type: "text_end",
                    contentIndex: 0,
                    content: state.accumulatedText,
                    partial: buildAssistantMsg({
                      model: modelInfo,
                      content: [{ type: "text", text: state.accumulatedText }],
                      stopReason: "stop",
                      usage: resultUsage,
                    }),
                  });
                }
              } else {
                // Error result
                const errorResult = message as { error?: string };
                throw new Error(errorResult.error ?? "Claude SDK returned an error");
              }
              break;
            }

            default:
              // Ignore system, status, auth_status, and other non-content messages
              break;
          }
        }

        // Build final content
        const content: AssistantMessage["content"] = [];
        if (state.accumulatedText) {
          content.push({ type: "text", text: state.accumulatedText } as TextContent);
        }
        for (const tc of state.toolCalls) {
          content.push(tc);
        }

        const stopReason: StopReason = state.toolCalls.length > 0 ? "toolUse" : "stop";

        const finalMessage = buildAssistantMsg({
          model: modelInfo,
          content,
          stopReason,
          usage: resultUsage,
        });

        // Close text block if still open
        if (state.textBlockOpen) {
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: state.accumulatedText,
            partial: finalMessage,
          });
        }

        stream.push({
          type: "done",
          reason: stopReason === "toolUse" ? "toolUse" : "stop",
          message: finalMessage,
        });

        log.info("Claude SDK query completed", {
          textLength: state.accumulatedText.length,
          toolCallCount: state.toolCalls.length,
          gotResult,
        });
      } catch (err) {
        const errObj = err as Error & { stderr?: string; exitCode?: number };
        log.error("Claude SDK stream error", {
          error: String(err),
          stderr: errObj.stderr?.slice(0, 500) || stderrLines.join("\n").slice(0, 500),
          exitCode: errObj.exitCode,
          stack: errObj.stack?.slice(0, 500),
        });
        stream.push({
          type: "error",
          reason: "error",
          error: buildErrorMsg({
            model: { api: "claude-sdk", provider: "claude-sdk", id: model.id },
            errorMessage: err instanceof Error ? err.message : String(err),
          }),
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}

// ── Model resolution ─────────────────────────────────────────────────────────

const MODEL_ALIASES: Record<string, string> = {
  "claude-opus-4-6": "opus",
  "claude-opus-4.6": "opus",
  "claude-opus-4-5": "opus",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-4.6": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-haiku-4-5": "haiku",
  "claude-haiku-3-5": "haiku",
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
};

function resolveClaudeModel(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  return MODEL_ALIASES[normalized] ?? modelId;
}
