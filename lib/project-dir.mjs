/**
 * The one piece of configuration this plugin cannot guess for you.
 *
 * It lives in its own file, with no imports beyond node:fs and node:path, for
 * a reason that is easy to undo by accident: `index.js` imports
 * `defineTool` from `@deepseek-ai/dsh-tools`, which is a peerDependency and is
 * NOT installed in a checkout of this repository. A harness that tried to
 * exercise this guard by importing `index.js` therefore never reached it — it
 * died on `Cannot find package '@deepseek-ai/dsh-tools'` and, because that
 * message happened to be an exception, a naive check would have scored it as
 * "the guard threw". Importing this file instead means the criterion tests the
 * real function, with nothing standing between it and the throw.
 *
 * @module lib/project-dir
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Resolve the pyroduct checkout from the row config (forward slashes ok).
 *
 * The checkout is neither optional nor guessable. Unlike the sibling MiniMax
 * plugin, this package deliberately ships NO bridge — `files` in package.json
 * carries no `vendor/jsoncli.js` — so every tool call spawns a real checkout's
 * `_build/js/.../jsoncli.js`. `moon build --target js` runs on first use if the
 * bridge is not built yet, but the checkout itself must exist.
 *
 * That makes a wrong `projectDir` the most likely way this plugin fails on a
 * fresh machine, and it used to fail in the worst possible way: the string
 * passed the only check that existed (non-empty), so `ensureBridge` spawned
 * `moon build` with a nonexistent cwd and surfaced an opaque spawn error naming
 * neither the cause nor the fix. Checking here, at configuration time, is the
 * last point where there is still something useful to say.
 *
 * @param {{ projectDir?: unknown }} config the row config
 * @returns {string} an absolute path to a MoonBit module
 * @throws {Error} naming the cause and the fix
 */
export function resolveProjectDir(config) {
  const dir = config && config.projectDir
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new Error(
      'pyroduct plugin: config.projectDir is required. This package ships no bridge, so it ' +
      'needs a local riantr/pyroduct checkout — the one whose cmd/jsoncli bridge answers the ' +
      'tool calls. Set it in your cordis config (the copy inside this package is a placeholder).',
    )
  }
  const resolved = path.resolve(dir)
  if (!existsSync(resolved)) {
    throw new Error(
      `pyroduct plugin: config.projectDir does not exist: ${resolved}. This package ships no ` +
      'bridge, so it needs a real riantr/pyroduct checkout on THIS machine. The value shipped ' +
      'in cordis.patch.yml is a placeholder — replace it with your own path.',
    )
  }
  if (!existsSync(path.join(resolved, 'moon.mod'))) {
    throw new Error(
      `pyroduct plugin: config.projectDir is not a MoonBit module (no moon.mod): ${resolved}. ` +
      'Point it at a riantr/pyroduct checkout itself, not at this package or at a parent of it.',
    )
  }
  return resolved
}
