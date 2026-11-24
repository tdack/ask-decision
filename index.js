// ask-decision: expose a decision model to agents as an on-demand tool.
// Decision models are not chat models, so they cannot be assigned to an agent's
// `model:`; this plugin is how an agent calls one. Failure-safe by contract: any
// error/timeout returns a tool error, never throws into the agent loop.
//
// Provider-agnostic: the provider and model are configuration, not discovery.
// The default comes from plugin options (see README); ask_decision can name
// another per call. The host validates: a provider/model that is not a decision
// model fails at call time with a specific error, passed through verbatim.
//
// Calls ctx.experimental.generate.decisions, which routes through the provider
// config (auth, baseURL). There is no direct-call fallback: the plugin cannot
// see providers or their baseURLs (ctx.provider.list() is empty inside a
// plugin), so any such fallback would have to hardcode one provider.
// ASK_DECISION_* env vars override options.
import { Plugin } from "@opencode/plugin"

const envNum = (name, fallback) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

// No built-in provider. The plugin is published for anyone to point at their own
// decision endpoint, so a default naming one would be wrong for most users.
// Options are required; see the README for providers known to work.
const DEFAULTS = {
  timeoutMs: envNum("ASK_DECISION_TIMEOUT_MS", 15000),
}

const README = "README.md"

// One question shape, mapped to the System One request body. `predicate` (noul)
// is a probability; `choice` and `score` are the other two the model accepts.
const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state", "questions"],
  properties: {
    state: {
      type: "string",
      description: "The text the questions are asked about. May be a JSON string for structured state.",
    },
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type", "instructions"],
        properties: {
          name: { type: "string", description: "Key this answer comes back under." },
          type: { type: "string", enum: ["predicate", "choice", "score"] },
          instructions: { type: "string", description: "What is being asked." },
          criteria: {
            type: "object",
            description:
              "predicate: Optional. choice: label -> description. score: label -> description for each level 0..n.",
            additionalProperties: { type: "string" },
          },
        },
      },
    },
    provider: {
      type: "string",
      description:
        "Optional. Configured decision provider. Omit for the plugin default. " +
        "The host rejects a provider/model that is not a decision model.",
    },
    model: {
      type: "string",
      description:
        "Optional. Model id on that provider. Omit for the plugin default. " +
        "The host rejects a provider/model that is not a decision model.",
    },
  },
}

// Map our input to the host's typed question shape: choice wants
// `choices: [{value, description}]` and score wants `levels: [...]`, not the
// criteria map callers write. Predicate is `predicate` with optional true/false
// criteria. Adapting here means callers use one shape.
function toHostQuestions(questions) {
  return questions.map((q) => {
    const criteria = q.criteria ?? {}
    if (q.type === "predicate") {
      return {
        name: q.name,
        type: "predicate",
        instructions: q.instructions,
        ...(Object.keys(criteria).length > 0 ? { criteria } : {}),
      }
    }
    if (q.type === "choice") {
      return {
        name: q.name,
        type: "choice",
        instructions: q.instructions,
        choices: Object.entries(criteria).map(([value, description]) => ({ value, description })),
      }
    }
    return {
      name: q.name,
      type: "score",
      instructions: q.instructions,
      levels: Object.values(criteria).map((description) => ({ label: description })),
    }
  })
}

// Call the host's decision generator. It routes through the provider config
// (auth, baseURL), so it works for any provider, and it validates: a
// provider/model that is not a decision model fails here.
async function callDecisions(ctx, opts, providerID, model, state, questions) {
  const api = ctx.experimental?.generate?.decisions
  if (typeof api !== "function") {
    throw new Error("this host exposes no decision API (ctx.experimental.generate.decisions)")
  }
  const res = await withTimeout(
    api({
      model: { providerID, id: model },
      input: [{ type: "text", text: state }],
      questions: toHostQuestions(questions),
    }),
    opts.timeoutMs,
  )
  return { answers: res?.answers ?? [], usage: res?.tokens ?? null, via: "host" }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`decision timed out after ${ms}ms`)), ms)),
  ])
}

export default Plugin.define({
  id: "ask-decision",
  async setup(ctx) {
    const opts = { ...DEFAULTS, ...(ctx.options ?? {}) }
    const defaultProvider = opts.providerID ?? process.env.ASK_DECISION_PROVIDER
    const defaultModel = opts.model ?? process.env.ASK_DECISION_MODEL

    // Not configured: say so once, plainly. The tool still registers, so the
    // message reaches the agent that calls it rather than being invisible.
    const unconfigured = !defaultProvider || !defaultModel
    const howTo =
      `ask_decision is not configured. Set options.providerID and options.model ` +
      `on the plugin entry in opencode.jsonc, or the ASK_DECISION_PROVIDER and ` +
      `ASK_DECISION_MODEL environment variables. See ${README}, Configure, for ` +
      `providers known to work.`

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "ask_decision",
        description: unconfigured
          ? `Ask a decision model calibrated questions about some text. NOT CONFIGURED — ` +
            `set options.providerID and options.model on this plugin, then restart.`
          : `Ask a decision model calibrated questions about some text. Returns one answer ` +
            `per question: a probability for \`predicate\`, or a ranked choice/score. ` +
            `Use for yes/no judgements, classification, or rating. Stateless. ` +
            `Default: ${defaultProvider}/${defaultModel}. ` +
            `Pass provider and/or model to use another; a model that is not a decision ` +
            `model is rejected by the host.`,
        input: INPUT_SCHEMA,
        async execute(input) {
          if (unconfigured) {
            return { content: howTo, metadata: { error: "unconfigured" } }
          }
          const state = input.state
          const questions = input.questions
          const providerID = input.provider ?? defaultProvider
          // A named provider needs its model given; there is no default to fall
          // back to, and guessing one would hide a mistake.
          const model = input.model ?? (providerID === defaultProvider ? defaultModel : undefined)
          if (!model) {
            return {
              content: `No model given for provider "${providerID}". Pass model as well, or name the configured provider (${defaultProvider}).`,
              metadata: { error: "no model", provider: providerID },
            }
          }
          try {
            const { answers, usage, via } = await callDecisions(ctx, opts, providerID, model, state, questions)
            const missing = questions.map((q) => q.name).filter((n) => !answers.some((a) => a.name === n))
            const meta = { answers, usage, via, provider: providerID, model }
            if (missing.length > 0) {
              return { content: `Decision model returned no answer for: ${missing.join(", ")}`, metadata: meta }
            }
            return { content: JSON.stringify({ answers }), metadata: meta }
          } catch (error) {
            // Failure-safe: surface as a tool error, never throw into the loop.
            // The host's message already names the problem (not a decision
            // model, model not found), so pass it through unchanged.
            return {
              content: `Decision model unavailable: ${error?.message ?? String(error)}`,
              metadata: { error: String(error), via: "none", provider: providerID, model },
            }
          }
        },
      })
    })
  },
})
