/**
 * DeepSeek Harness plugin for riantr/pyroduct.
 *
 * Exposes the philosophy state-machine family and its analysis faces to the
 * agent as ordinary tools. All model semantics stay in MoonBit: the tools
 * spawn the module's `cmd/jsoncli` bridge (a Node-runnable JS bundle built by
 * `moon build --target js`) and the module's own gate commands. The plugin is
 * a spawner and a formatter, never a second implementation.
 *
 * Provenance: the plugin form follows the shipped
 * @riantr/moonbit-static-analysis-dsh plugin (spawner + formatter, one JSON
 * bridge, `inject = ['tools']`); every pyroduct fact stays in riantr/pyroduct.
 *
 * @module @riantr/pyroduct-dsh
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Service the plugin registers into; plugin loading is inert without tools. */
export const inject = ['tools']

const DEFAULT_TIMEOUT_MS = 60_000
const GATE_TIMEOUT_MS = 600_000

/**
 * The faces list, mirroring the bridge's `faces()` — which is a *checked*
 * mirror, not a promise: `tools/validate.mjs` reads this array out of this file,
 * asks the bridge for its own list, and fails on any difference in either
 * direction. That check earned its place: this list had silently fallen three
 * faces behind, and because it is the `enum` of the `pyroduct_face` tool's
 * `kind`, every one of those faces was rejected by the schema before the model
 * could ask for it.
 */
const FACES = [
  'report', 'slots', 'loop', 'multi', 'group', 'society', 'evolution', 'cycle',
  'coordinator', 'dmlref', 'causal', 'audit', 'fleet', 'mutants', 'mbti',
  'mermaid', 'dot', 'genesis', 'course', 'naming', 'principle', 'intuition',
  'ml', 'ml-export', 'spec',
  'association', 'pathsum', 'algebra', 'petri', 'aho', 'buchi',
]

/** Resolve the pyroduct checkout from the row config (forward slashes ok). */
function projectDirOf(config) {
  const dir = config && config.projectDir
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new Error('pyroduct plugin: config.projectDir is required')
  }
  return path.resolve(dir)
}

/**
 * Resolve a runnable Node. Inside the Electron host `process.execPath` is the
 * app binary, so prefer the bundled runtime node when present.
 */
function nodePathOf(config) {
  if (typeof config?.nodePath === 'string' && existsSync(config.nodePath)) return config.nodePath
  const resources = process.resourcesPath
  if (typeof resources === 'string') {
    const candidate = path.join(
      resources,
      'runtime',
      'primary-runtime',
      'dependencies',
      'node',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    )
    if (existsSync(candidate)) return candidate
  }
  return process.execPath
}

/** Resolve the moon binary; CreateProcess appends .exe on Windows. */
function moonPathOf(config) {
  if (typeof config?.moonPath === 'string' && config.moonPath.length > 0) return config.moonPath
  return 'moon'
}

/** One spawned process: collected stdout/stderr, exit code, signal support. */
function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

const BRIDGE_RELATIVE = path.join('_build', 'js', 'debug', 'build', 'cmd', 'jsoncli', 'jsoncli.js')

/** Build the bridge on first use, then reuse the bundle. */
async function ensureBridge(projectDir, config) {
  const bridge = path.join(projectDir, BRIDGE_RELATIVE)
  if (existsSync(bridge)) return bridge
  const result = await runProcess(moonPathOf(config), ['build', '--target', 'js'], {
    cwd: projectDir,
    timeoutMs: GATE_TIMEOUT_MS,
  })
  if (!existsSync(bridge)) {
    throw new Error(
      `jsoncli bridge missing after build in ${projectDir}: ${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
    )
  }
  return bridge
}

/** One JSON request through the bridge; replies are parsed JSON envelopes. */
async function callBridge(projectDir, config, request, signal) {
  const bridge = await ensureBridge(projectDir, config)
  const result = await runProcess(nodePathOf(config), [bridge, JSON.stringify(request)], {
    cwd: projectDir,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    signal,
  })
  const line = result.stdout.trim().split('\n').pop() ?? ''
  let reply
  try {
    reply = JSON.parse(line)
  } catch {
    throw new Error(
      `bridge reply unparseable (exit ${result.code}): ${line.slice(0, 200) || result.stderr.trim().slice(0, 200)}`,
    )
  }
  if (reply.ok !== true) {
    throw new Error(`bridge reported failure: ${String(reply.error ?? 'unknown error')}`)
  }
  return reply
}

/**
 * Register the module's tools on the host tool registry.
 *
 * @param ctx - registrant context carrying `ctx.tools`.
 * @param config - the row config: `projectDir` (required), `nodePath`, `moonPath`.
 */
export function apply(ctx, config) {
  const projectDir = projectDirOf(config)

  ctx.tools.register(
    defineTool({
      name: 'pyroduct_report',
      description:
        'Full report of the pyroduct subject state machine — a moral-development machine built from two Chinese philosophy texts: 34 states · 53 transitions · 11 phases, the two-character naming table with page citations, and the developmental positions. Use when a question needs the machine\'s own facts (positions, names, provenance layers) rather than the analysis faces.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            report: { type: 'string' },
          },
          required: ['report'],
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      async execute(args, exec) {
        const reply = await callBridge(projectDir, config, { kind: 'report' }, exec.signal)
        return { report: reply.rendered.trimEnd() }
      },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'pyroduct_face',
      description:
        'Run one pyroduct analysis face and return its report. Faces mirror the machine-facing subcommands: slots (49 triggers → 8 drive slots), loop (position × slot step contract), petri (Petri-net face: places/transitions/marking/firing, token-conserving), aho (Aho-Corasick face: trigger-sentence trie with failure links), buchi (ω-view: nonemptiness/liveness/stalls), pathsum (tropical shortest path), algebra (machine algebra/minimal quotient), spec (machine as JSON), plus multi/group/society/evolution/cycle/coordinator/dmlref/causal/audit and more.',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: FACES,
          description: 'Which face to run (the bridge\'s faces list).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            report: { type: 'string' },
            kind: { type: 'string' },
          },
          required: ['report', 'kind'],
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      async execute(args, exec) {
        const reply = await callBridge(projectDir, config, { kind: args.kind }, exec.signal)
        return { report: reply.rendered.trimEnd(), kind: reply.kind }
      },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'pyroduct_gates',
      description:
        'Run the pyroduct gate suite with the local toolchain: moon check + fmt --check + test (wasm target; 197 tests). Returns per-command exit codes and the test totals. Use before and after changing the pyroduct model or the published package.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string' },
            failed: { type: 'integer' },
          },
          required: ['summary', 'failed'],
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args, exec) {
        const specs = [['check'], ['fmt', '--check'], ['test']]
        const lines = []
        let failed = 0
        for (const spec of specs) {
          let outcome
          try {
            outcome = await runProcess(moonPathOf(config), spec, {
              cwd: projectDir,
              timeoutMs: GATE_TIMEOUT_MS,
              signal: exec.signal,
            })
          } catch (error) {
            failed += 1
            lines.push(`pyroduct: moon ${spec.join(' ')} -> spawn error: ${String(error)}`)
            continue
          }
          if (outcome.code !== 0) failed += 1
          const tail = `${outcome.stdout}\n${outcome.stderr}`
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .slice(-3)
            .join(' / ')
          lines.push(`pyroduct: moon ${spec.join(' ')} -> exit ${outcome.code}${tail ? ` | ${tail}` : ''}`)
        }
        return { summary: lines.join('\n'), failed }
      },
      timeoutMs: GATE_TIMEOUT_MS,
    }),
  )
}
