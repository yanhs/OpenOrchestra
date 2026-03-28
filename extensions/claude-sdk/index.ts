/**
 * Claude SDK Provider Plugin for OpenClaw.
 *
 * Uses @anthropic-ai/claude-agent-sdk to run Claude via the local CLI binary,
 * authenticated through the user's Pro/Max subscription — no API key required.
 *
 * This is the recommended provider for users who have a Claude subscription
 * and want to avoid API costs.
 */

import {
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { cloneFirstTemplateModel } from "openclaw/plugin-sdk/provider-model-shared";
import { createClaudeSdkStreamFn } from "./stream.js";

const PROVIDER_ID = "claude-sdk";

const SUPPORTED_MODELS = [
  "claude-sdk/claude-opus-4-6",
  "claude-sdk/claude-sonnet-4-6",
  "claude-sdk/claude-opus-4-5",
  "claude-sdk/claude-sonnet-4-5",
  "claude-sdk/claude-haiku-4-5",
] as const;

const MODEL_ID_PREFIXES = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

function matchesClaudeSdkModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return MODEL_ID_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function resolveForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim().toLowerCase();

  // Try to find a template model from the 4.5 series for 4.6 models
  const templateMap: Record<string, string[]> = {
    "claude-opus-4-6": ["claude-opus-4-5"],
    "claude-opus-4.6": ["claude-opus-4-5"],
    "claude-sonnet-4-6": ["claude-sonnet-4-5"],
    "claude-sonnet-4.6": ["claude-sonnet-4-5"],
  };

  for (const [prefix, templateIds] of Object.entries(templateMap)) {
    if (trimmedModelId.startsWith(prefix)) {
      return cloneFirstTemplateModel({
        providerId: PROVIDER_ID,
        modelId: ctx.modelId.trim(),
        templateIds,
        ctx,
      });
    }
  }

  return undefined;
}

/**
 * Check if Claude CLI is available and authenticated.
 */
async function checkClaudeCliAvailable(): Promise<{ available: boolean; error?: string }> {
  try {
    const { execSync } = await import("node:child_process");
    execSync("claude --version", { stdio: "pipe", timeout: 5000 });
    return { available: true };
  } catch {
    return {
      available: false,
      error: "Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code",
    };
  }
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Claude SDK Provider",
  description: "Use Claude via local CLI with Pro/Max subscription — no API key needed",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Claude SDK (subscription)",
      docsPath: "/providers/claude-sdk",
      envVars: [],
      auth: [
        {
          id: "subscription",
          label: "Claude subscription",
          hint: "Use local Claude CLI — authenticated via your Pro/Max subscription",
          kind: "custom",
          wizard: {
            choiceId: "claude-sdk-subscription",
            choiceLabel: "Claude SDK (subscription)",
            choiceHint: "No API key needed — uses your Claude Pro/Max subscription",
            groupId: "claude-sdk",
            groupLabel: "Claude SDK",
            groupHint: "Claude Code subscription (no API key)",
            modelAllowlist: {
              allowedKeys: [...SUPPORTED_MODELS],
              initialSelections: ["claude-sdk/claude-sonnet-4-6"],
              message: "Claude SDK models (subscription)",
            },
          },
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const check = await checkClaudeCliAvailable();
            if (!check.available) {
              throw new Error(check.error ?? "Claude CLI not available");
            }

            await ctx.prompter.note(
              [
                "Claude SDK provider uses your local Claude CLI installation.",
                "It authenticates via your Claude Pro/Max subscription.",
                "No API key is needed — all costs are covered by your subscription.",
                "",
                "Make sure you are logged in: run `claude auth login` if needed.",
              ].join("\n"),
              "Claude SDK (subscription)",
            );

            return {
              profiles: [
                {
                  profileId: "claude-sdk:default",
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    // Marker key — the SDK uses CLI auth, not an API key
                    key: "claude-sdk-subscription",
                  },
                },
              ],
              configPatch: {
                agents: {
                  defaults: {
                    model: {
                      primary: "claude-sdk/claude-sonnet-4-6",
                    },
                  },
                },
              },
            };
          },
          runNonInteractive: async (ctx) => {
            const check = await checkClaudeCliAvailable();
            if (!check.available) {
              ctx.runtime.error(check.error ?? "Claude CLI not available");
              ctx.runtime.exit(1);
              return null;
            }

            return {
              ...ctx.config,
              agents: {
                ...ctx.config.agents,
                defaults: {
                  ...ctx.config.agents?.defaults,
                  model: {
                    primary: "claude-sdk/claude-sonnet-4-6",
                  },
                },
              },
            };
          },
        },
      ],

      // Stream function — the core: bridges Agent SDK to OpenClaw streaming
      createStreamFn: () => {
        return createClaudeSdkStreamFn({
          permissionMode: "bypassPermissions",
          maxTurns: 200,
        });
      },

      resolveDynamicModel: (ctx) => resolveForwardCompatModel(ctx),

      capabilities: {
        providerFamily: "anthropic",
        dropThinkingBlockModelHints: ["claude"],
      },

      isModernModelRef: ({ modelId }) => matchesClaudeSdkModel(modelId),

      resolveDefaultThinkingLevel: ({ modelId }) => {
        const lower = modelId.trim().toLowerCase();
        if (
          lower.startsWith("claude-opus-4-6") ||
          lower.startsWith("claude-sonnet-4-6") ||
          lower.startsWith("claude-opus-4-5") ||
          lower.startsWith("claude-sonnet-4-5")
        ) {
          return "adaptive";
        }
        return undefined;
      },

      isCacheTtlEligible: () => false,
    });
  },
});
