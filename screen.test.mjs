// Self-check for the pure mapping in index.js. Run: node screen.test.mjs
// Covers only the mapping and resolution logic; the live call is exercised by
// asking the agent to use ask_decision.
//
// NOTE: this is a mirrored self-check — the test does NOT exercise the
// actual index.js code, and may drift due to changed defaults, logic, or
// environment. Any divergence between this test and index.js is a real drift
// that must be investigated separately.
// Shortcut: the mirror test assumes explicit provider/model configuration;
// it does not validate that index.js's own defaults are identical.
import assert from "assert"

// Mirror of the provider/model resolution in index.js.
function resolve(providerID, model, defaults) {
  const p = providerID ?? defaults.providerID
  const m = model ?? (p === defaults.providerID ? defaults.model : undefined)
  return { providerID: p, model: m }
}

// FIX: changed DEFAULTS from { providerID: "ollama-s1", model: "clef-flash" }
// to { providerID: "ollama", model: "clef-flash" } to match the actual
// index.js fallback logic: `input.provider ?? defaultProvider` and
// `input.model ?? (providerID === defaultProvider ? defaultModel : undefined)`.
const DEFAULTS = { providerID: "ollama", model: "clef-flash" }

// nothing given -> the configured default (ollama, clef-flash)
assert.deepStrictEqual(resolve(undefined, undefined, DEFAULTS), {
  providerID: "ollama",
  model: "clef-flash",
})
// provider alone, not the default -> no model; the caller must supply one
assert.deepStrictEqual(resolve("openrouter", undefined, DEFAULTS), {
  providerID: "openrouter",
  model: undefined,
})
// provider + model -> both taken verbatim, no validation here
assert.deepStrictEqual(resolve("openrouter", "typesafe/jev-1.14", DEFAULTS), {
  providerID: "openrouter",
  model: "typesafe/jev-1.14",
})
// model alone against the default provider -> kept
assert.deepStrictEqual(resolve(undefined, "other-model", DEFAULTS), {
  providerID: "ollama",
  model: "other-model",
})
// naming the default provider explicitly still yields the default model
assert.deepStrictEqual(resolve("ollama", undefined, DEFAULTS), {
  providerID: "ollama",
  model: "clef-flash",
})

// Mirror of the host-shape translation — keep in sync with index.js.
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

// predicate passes through; criteria omitted when empty
assert.deepStrictEqual(
  toHostQuestions([{ name: "a", type: "predicate", instructions: "hi?" }]),
  [{ name: "a", type: "predicate", instructions: "hi?" }],
)
// choice maps the label map to [{value, description}]
assert.deepStrictEqual(
  toHostQuestions([
    { name: "m", type: "choice", instructions: "tone?", criteria: { warm: "friendly", cold: "unfriendly" } },
  ]),
  [{ name: "m", type: "choice", instructions: "tone?", choices: [
    { value: "warm", description: "friendly" },
    { value: "cold", description: "unfriendly" },
  ] }],
)
// score maps to an ordered levels array of {label}, key order preserved
assert.deepStrictEqual(
  toHostQuestions([
    { name: "f", type: "score", instructions: "formal?", criteria: { "0": "casual", "1": "formal" } },
  ]),
  [{ name: "f", type: "score", instructions: "formal?", levels: [
    { label: "casual" }, { label: "formal" },
  ] }],
)
// the host shape never carries `criteria` on choice/score — that was the bug
for (const q of toHostQuestions([
  { name: "c", type: "choice", instructions: "x", criteria: { a: "b" } },
  { name: "s", type: "score", instructions: "y", criteria: { "0": "z" } },
])) {
  assert.strictEqual(q.criteria, undefined)
  assert.ok(q.choices || q.levels)
}

console.log("ask-decision screen.test.mjs: all checks passed")
