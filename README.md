# ask-decision

Registers an `ask_decision` tool so any agent can put typed questions to a
**decision model** on demand. Provider-agnostic: it calls whatever provider and
model it is told to.

Decision models are not chat models — they cannot be assigned to an agent's
`model:`. A plugin tool is the only route.

## Install

```sh
opencode plugin add github:tdack/ask-decision
```

> Not published to npm. Install via the GitHub route above. Do not use an npm package name — `opencode-ask-decision` is not on the registry.

## License

[MIT](LICENSE)

## Configure

Options go on the plugin entry in `opencode.jsonc`. Declaring the plugin also
supersedes auto-discovery, so it loads once, with your options.

```jsonc
"plugins": [
  "@cloudflare/aig-opencode-plugin",
  "opencode-cache-hit@latest",
  {
    "package": "github:tdack/ask-decision",
    "options": {
      "providerID": "openrouter",
      "model": "typesafe/jev-1.14"
    }
  }
]
```

| Option | Required | Meaning |
|--------|----------|---------|
| `providerID` | yes | Provider that serves a decision model. |
| `model` | yes | Model id on that provider. |
| `timeoutMs` | no (`15000`) | Per-call timeout. |

`providerID` and `model` have **no defaults**. A plugin shipped for anyone to
point at their own endpoint cannot guess yours, and a wrong guess would look like
a broken model rather than missing config. If they are unset the tool still
registers, and every call returns the configuration instructions:

```
ask_decision is not configured. Set options.providerID and options.model
on the plugin entry in opencode.jsonc, or the ASK_DECISION_PROVIDER and
ASK_DECISION_MODEL environment variables. See README.md, Configure, for
providers known to work.
```

Environment variables override, same names with an `ASK_DECISION_` prefix:
`ASK_DECISION_PROVIDER`, `ASK_DECISION_MODEL`, `ASK_DECISION_TIMEOUT_MS`.

### Where the decision models come from

They are declared, not discovered. A provider entry using the `/decisions`
package tells OpenCode where to send System One requests; the `providerID` and
`model` options then name which one to use. See *Adding a decision model*.

The plugin has no built-in default provider or model. `providerID` and `model`
must be explicitly configured via plugin options or the `ASK_DECISION_PROVIDER`
/ `ASK_DECISION_MODEL` environment variables. A parent chat provider can serve
decision requests only when its model entry declares the `/decisions` package
(see *Adding a decision model*). Without that package override, OpenCode
rejects the call.

A provider's own model list is not the test of whether a decision model works —
OpenRouter's `/api/v1/models`, for instance, lists no decision model, yet serves
one over System One. Calling it is the only real check, and the error says what
went wrong when it fails.

### Known-good providers

| Provider | Model | Endpoint | Credential |
|----------|-------|----------|------------|
| `openrouter` | `typesafe/jev-1.14` | `https://openrouter.ai/api/v1` | OpenRouter key — verified |
| `fluence` | `typesafe/jev` | `https://api.fluence.cloud/v1` | Fluence key — verified |
| TypeSafe (hosted) | `jev-latest` | `https://api.typesafe.ai/v1` | TypeSafe key — not verified here |
| `ollama` | `clef-flash` | `http://localhost:11434/v1` | none — verified |

The first three are the same underlying model reached three ways, so they are
interchangeable on scores. `clef-flash` is **not**: it runs lower than Jev (a
strong fit is about `0.17`), so thresholds tuned for one do not transfer.

`openrouter` is a built-in provider: declaring the model on its existing entry
means the request uses whatever credential OpenCode already has stored for it,
with no key in the config.

`localhost:11434` is Ollama's default address. If Ollama runs on another host,
use that host instead.

See *Adding a decision model* for the shape; only `baseURL`, `env` and the model
id differ between them.

### Adding a decision model

Anything that serves System One (`POST /systemone` with `{model, state, questions}`)
can be a decision model. Usually it belongs on a provider you already have — the
model goes in that provider's `models`, not a separate provider entry:

```jsonc
"ollama": {
  "name": "Ollama",
  "package": "@opencode/ai/providers/openai-compatible",
  "settings": { "baseURL": "http://localhost:11434/v1" },
  // "env": ["PROVIDER_API_KEY"],  // only when the provider needs a key; Ollama needs none
  "models": {
    "qwen3.5:9b": { "name": "Qwen 3.5" },
    "clef-flash": {
      "name": "Clef Flash",
      "type": "decision",
      // required when the provider declares a chat package; without it the
      // model inherits that package and OpenCode rejects the decision call
      "package": "@opencode/ai/providers/openai-compatible/decisions",
      "compatibility": { "mediaInput": "state" },
      "capabilities": {
        "tools": false,
        "input": ["text"],
        "output": ["decision"],
        "temperature": false
      }
    }
  }
}
```

Then name it:

```jsonc
{ "options": { "providerID": "ollama", "model": "clef-flash" } }
```

The model entry reuses the provider's `baseURL` and credential, so nothing is
duplicated.

Fields that make a model a decision model:

- model `type: "decision"` — what OpenCode checks before routing.
- `capabilities.output: ["decision"]` — declares decision answers, not text.
- `package` — **required when the provider declares a chat package**, because the
  model would otherwise inherit it. Without the override OpenCode rejects the
  call with *"has no decision API opencode can call (package …openai-compatible)"*.
  A provider with no `package` of its own (like the built-in `openrouter`) needs
  no override.

`compatibility.mediaInput: "state"` says the state is passed whole rather than as
chat messages; keep it for System One endpoints.

Only use a separate provider entry when the decision endpoint is a *different
address* from your chat one. If it shares the address, adding the model is
enough.

Declaring the provider is not enough on its own — the model behind it has to
actually serve System One, and the caller has to be allowed to use it. If a call
fails, the error names which of those it was.

## Use

```
ask_decision(state, questions, provider?, model?)
```

`provider` and `model` override the configured values per call. Both are
optional; omit them to use the configured provider and model. Naming a *different*
provider requires its `model` too, since there is no default to fall back to.

Each question is one of:

| `type` | Needs | Returns |
|--------|-------|---------|
| `predicate` | `criteria.true` / `criteria.false` (optional) | `probability` in `[0, 1]` |
| `choice` | `criteria`: label → description | `choice`, `probabilities`, `confidence` |
| `score` | `criteria`: level → description, sent in key order | `score`, `probabilities`, `confidence` |

`probabilities` comes back as a list of `{ value, probability }`; `score` levels
also carry their `label`. Answers arrive in the same order as the questions.

### Common shapes

The `jev` CLI's verbs are all the same call with different input shaping, so
each maps onto one `ask_decision` call. The verbs are named below only because
they are the vocabulary the team already uses.

**yes / gutcheck** — one `predicate`. Read the probability, apply your own
threshold. The threshold is the caller's job, not the model's.

```json
{ "state": "The package arrived three days late.",
  "questions": [{ "name": "delivery", "type": "predicate",
    "instructions": "Does the state text describe a package delivery?" }] }
```

**pick** — one `choice`. Read `choice` for the answer, `probabilities` to see how
close the runners-up were, `confidence` to judge whether to act.

```json
{ "state": "I was charged twice for the same order.",
  "questions": [{ "name": "team", "type": "choice",
    "instructions": "Which team should handle this?",
    "criteria": { "billing": "Charges, invoices, refunds",
                  "orders": "Order status, delivery, returns",
                  "account": "Login, profile, permissions" } }] }
```

**rate** — one `score`, criteria ordered low to high. `score` is the position on
that scale; `probabilities` gives the spread across levels.

```json
{ "state": "This is the third time I have had to ask.",
  "questions": [{ "name": "anger", "type": "score",
    "instructions": "How angry is the author?",
    "criteria": { "0": "Calm and matter-of-fact",
                  "1": "Frustrated but civil",
                  "2": "Hostile or threatening to leave" } }] }
```

**ask** — several questions in one call, mixing all three types. This is the
shape to reach for by default: one round trip, independent answers.

```json
{ "state": "…",
  "questions": [
    { "name": "delivery", "type": "predicate", "instructions": "…?" },
    { "name": "team", "type": "choice", "instructions": "…?", "criteria": { "…": "…" } },
    { "name": "anger", "type": "score", "instructions": "…?", "criteria": { "0": "…", "1": "…" } } ] }
```

**batch** — the same questions over many rows. There is no tool for this and it
does not need one: an agent can loop, calling `ask_decision` once per row. If it
becomes a routine job, wrap that loop in a **skill** rather than growing this
plugin — the work is I/O and iteration, not judgement.

**rank** — order many candidates against a query. There is deliberately no
single-call form. Send **one question per candidate**, with the candidate
embedded in that question's own instruction text, then sort the results
yourself:

```json
{ "state": "Query: a bug that causes data loss",
  "questions": [
    { "name": "c0", "type": "predicate",
      "instructions": "Candidate: 'Import silently drops rows on timeout'. Does the candidate match the query?" },
    { "name": "c1", "type": "predicate",
      "instructions": "Candidate: 'Tooltip is misaligned on 4K displays'. Does the candidate match the query?" } ] }
```

Then sort by `probability`, descending. Use `score` instead of `predicate` for a
graded ranking, and apply your own `min` cutoff afterwards.

`state` and `instructions` both take **strings only** — a JSON object is
rejected. `state` may be a JSON *string* (useful for a query plus shared
context); the candidate must appear in the instruction text, embedded per
question. Do **not** put candidates in an array and refer to them as
`candidates[i]`: the `jev` CLI measured positional references at 86/320 wrong on
a 150-item array, against 0/320 for an embedded item — past ~20 candidates the
two stop being interchangeable. Chunk long lists and fan out if needed; that is a
loop, so it belongs in the caller (or a skill), not here.

## Validation

**OpenCode** validates, not this plugin. A provider or model that is not a
decision model fails at call time, and the error is passed through unchanged:

```
Decision model unavailable: openrouter/z-ai/glm-5.3-flash is a chat model, not a decision model
Decision model unavailable: Model not found: nope/whatever
```

So a wrong model is reported by name rather than silently ignored.

## Behaviour

- Any error or timeout returns a tool error. Nothing throws into the agent loop.
- Calls OpenCode's `ctx.experimental.generate.decisions`, which routes through
  the provider config (auth, baseURL) and so works for any provider.
- No direct-call fallback. A plugin cannot see providers or their baseURLs
  (`ctx.provider.list()` is empty inside a plugin), so any such fallback would
  have to hardcode one provider.

## Test

```
node screen.test.mjs
```

Covers the question mapping and the provider/model resolution rules. The live
call is exercised by asking an agent to use `ask_decision`.
