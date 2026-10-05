# dsh-plugin-pyroduct

[DeepSeek Harness](https://github.com/deepseek-ai) plugin for
[riantr/pyroduct](https://github.com/riantr/pyroduct) — a pure-MoonBit module
that turns two Chinese philosophy texts into runnable, tested state machines.

## What it exposes

Three agent tools, registered through `@deepseek-ai/dsh-tools`:

| Tool | What it does |
|------|--------------|
| `pyroduct_report` | Full subject-machine report: 34 states · 53 transitions · 11 phases, the two-character naming table with page citations, developmental positions |
| `pyroduct_face` | One analysis face by `kind`: `slots` (49 triggers → 8 drive slots), `loop` (position × slot step contract), `petri` (Petri-net face), `aho` (Aho-Corasick face), `buchi` (ω-view), `pathsum` (tropical shortest path), `algebra` (machine algebra), `spec` (machine as JSON), plus `multi` / `group` / `society` / `evolution` / `cycle` / `coordinator` / `dmlref` / `causal` / `audit` and more |
| `pyroduct_gates` | The pyroduct gate suite: `moon check` + `fmt --check` + `test` (wasm target, 129 tests) with per-command exit codes |

## How it works

The plugin is **a spawner and a formatter, never a second implementation**.
All model semantics stay in MoonBit, versioned and gated with the module
itself. Each tool call:

1. spawns the `cmd/jsoncli` bridge — a Node-runnable JS bundle built by
   `moon build --target js` (built on first use, then reused);
2. passes **one** JSON request argument, e.g. `{ "kind": "petri" }`;
3. reads **one line** of JSON from stdout: `{ok, kind, rendered, faces}`;
4. renders `rendered` as the tool's text output.

## Install (local checkout)

In the DSH profile directory (`~/.dsh/profiles/<profile>`), add the plugin to
`package.json` and its bundle list, then `pnpm install`:

```json
{
  "dependencies": {
    "@local/pyroduct-dsh": "link:D:/src/DeepseekHarness/Projects/dsh-plugin-pyroduct"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/pyroduct-dsh"]
    }
  }
}
```

The shipped `cordis.patch.yml` mounts the plugin with
`config.projectDir = D:/src/DeepseekHarness/Projects/pyroduct`; override it in
the profile's own `cordis.patch.yml` (id-targeted `config` entry) if your
checkout lives elsewhere. `nodePath`/`moonPath` override the resolved binaries.

Restart the app after installing — profile bundles load at boot.

## Provenance

The plugin form follows the shipped
`@riantr/moonbit-static-analysis-dsh` plugin (spawner + formatter, one JSON
bridge, `inject = ['tools']`). Every pyroduct fact stays in
[riantr/pyroduct](https://github.com/riantr/pyroduct); the plugin holds none.

## License

MIT
