/**
 * Anti-drift harness for the DeepSeek Harness plugin (@riantr/pyroduct-dsh).
 *
 * The plugin is a spawner and a formatter: every fact it shows comes from the
 * pyroduct module through the `cmd/jsoncli` bridge. What it *hard-codes* is
 * therefore a set of claims about that module, and each one is a number or a
 * list that moves with every release:
 *
 *   - `FACES` in index.js, which is the `enum` of the `pyroduct_face` tool's
 *     `kind` parameter. A face missing here is not merely undocumented, it is
 *     REJECTED by the schema — the model cannot ask for it at all. The source
 *     comment calls this list "anti-drift"; nothing checked it, and it had
 *     fallen three faces behind (fleet / mutants / mbti).
 *   - the test count quoted in the `pyroduct_gates` description and in the
 *     README, which had drifted to 129 while the suite runs 197.
 *   - the three registered tool names.
 *
 * The module is the oracle, never a copy kept in this repo: the bridge's reply
 * envelope already carries its own `faces` list (that is what the field is
 * documented to be for), and `moon test` prints the real total. So these checks
 * update themselves when the module moves — there is no pin to bump here.
 *
 * Usage:
 *   PYRODUCT_PROJECT_DIR=/path/to/pyroduct node tools/validate.mjs
 *
 * The project dir is the same one the plugin is configured with (the row config
 * `projectDir`), and it must have its bridge built; the workflow builds it.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PROJECT = process.env.PYRODUCT_PROJECT_DIR
const MOON = process.env.MOON_PATH && process.env.MOON_PATH.length > 0 ? process.env.MOON_PATH : 'moon'
const BRIDGE = path.join(PROJECT ?? '', '_build', 'js', 'debug', 'build', 'cmd', 'jsoncli', 'jsoncli.js')

const problems = []
let checkCount = 0
function check(label, condition, detail = '') {
  const ok = Boolean(condition)
  checkCount += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) problems.push(label)
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

// ---------------------------------------------------------------- static shape

const indexSource = readFileSync(path.join(ROOT, 'index.js'), 'utf8')

const facesMatch = indexSource.match(/const FACES\s*=\s*\[([\s\S]*?)\]/)
const faces = facesMatch ? [...facesMatch[1].matchAll(/'([a-z][a-z-]*)'/g)].map((m) => m[1]) : []
check('index.js declares a FACES list', faces.length > 0, `${faces.length} faces`)
check('FACES has no duplicates', new Set(faces).size === faces.length,
  faces.length - new Set(faces).size === 0 ? 'none' : `${faces.length - new Set(faces).size} duplicate(s)`)

for (const tool of ['pyroduct_report', 'pyroduct_face', 'pyroduct_gates']) {
  check(`tool ${tool} is registered`, indexSource.includes(`name: '${tool}'`))
}

for (const file of ['package.json', ...readdirSync(path.join(ROOT, 'locale')).map((f) => path.join('locale', f))]) {
  let parsed = true
  let detail = ''
  try {
    JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'))
  } catch (error) {
    parsed = false
    detail = String(error.message).slice(0, 120)
  }
  check(`${file} is valid JSON`, parsed, detail)
}

const syntax = await run(process.execPath, ['--check', path.join(ROOT, 'index.js')])
check('index.js parses as an ES module', syntax.code === 0, syntax.stderr.trim().split('\n')[0] ?? '')

// ------------------------------------------------- the publish workflow's shape
//
// The publish workflow fails SILENTLY when it is wrong, in two different ways,
// and neither is visible until a tag is pushed:
//
//   1. This repository's Actions policy allows only actions owned by riantr
//      and pinned to a full-length commit SHA. `actions/checkout` and
//      `actions/setup-node` both fail that test, and GitHub rejects them
//      while SETTING UP the job — before any job exists. The signature is
//      `conclusion: startup_failure` with zero jobs, which is how every run
//      here failed before the checkout became plain git.
//
//   2. Without `id-token: write` there is no OIDC identity, so npm has
//      nothing to authenticate with and the publish fails with an opaque
//      ENEEDAUTH — after the whole gate has already passed.
//
// Both are properties of a file that no other check looked at, and the tag
// that would expose them is pushed rarely. So they are checked here, on
// every push, as text. This deliberately does not parse YAML: the package
// ships no dependencies, the checks below are all "does this string appear",
// and a parser would add a dependency to a package that deliberately has
// none.
const publishPath = path.join(ROOT, '.github', 'workflows', 'publish.yml')
const publishExists = existsSync(publishPath)
check('a publish workflow exists', publishExists, publishExists ? '.github/workflows/publish.yml' : 'missing')
if (publishExists) {
  const publishSource = readFileSync(publishPath, 'utf8')
  // Comments are stripped before anything is matched. The header of this
  // workflow NAMES `id-token: write` to explain that the permission is what
  // the whole mechanism rests on — and a check that reads those words out of
  // a comment would be satisfied by a file that grants no permission at all.
  // That is not hypothetical: the first version of this criterion passed
  // with the permission deleted, because the explanation in the comment
  // still said the words.
  const publishCode = publishSource.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  const permissionsBlock = publishCode.match(/^permissions:\s*\n((?:[ \t]+.*\n?)+)/m)?.[1] ?? ''
  check('the publish workflow requests an OIDC identity',
    /id-token:\s*write/.test(permissionsBlock),
    /id-token:\s*write/.test(permissionsBlock) ? 'permissions: id-token: write'
      : permissionsBlock.trim() === '' ? 'no permissions block at all'
        : `permissions block lacks id-token: write (${permissionsBlock.trim().replace(/\n/g, ', ')})`)
  const usesRefs = [...publishCode.matchAll(/^\s*-\s*uses:\s*(\S+)/gm)].map((m) => m[1])
  check('the publish workflow uses no third-party action',
    usesRefs.length === 0,
    usesRefs.length === 0 ? 'plain git, as the Actions policy requires'
      : `would be rejected at job setup: ${usesRefs.join(', ')}`)
  check('the publish workflow triggers on version tags',
    /tags:\s*\n\s*-\s*'v\*'/.test(publishCode),
    /tags:\s*\n\s*-\s*'v\*'/.test(publishCode) ? "tags: 'v*'" : 'no v* tag filter')
  // Only the executable lines are inspected. The comment above the publish
  // step NAMES --otp and NODE_AUTH_TOKEN to explain why they are absent, and
  // a check that reads those words out of a comment would be reddened by
  // exactly the documentation that keeps the next editor from adding them.
  // A criterion that a good comment can trip is a criterion that teaches
  // people to delete good comments.
  const publishStep = (publishSource.split(/^\s*-\s*name:\s*Publish\s*$/m)[1] ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  const tokenish = ['--otp', 'NODE_AUTH_TOKEN', '_authToken'].filter((t) => publishStep.includes(t))
  check('the publish step carries no token and no --otp',
    tokenish.length === 0,
    tokenish.length === 0 ? 'OIDC only — the CLI authenticates itself'
      : `mentions ${tokenish.join(', ')}`)
}

// --------------------------------------------------- what the package ships to npm
//
// `cordis.patch.yml` is inside the `files` list in package.json, so whatever
// `projectDir` it holds is handed to every consumer who installs this. It used
// to hold the author's absolute checkout path: a value that is not merely
// unhelpful but guaranteed wrong on every other machine — and nothing checked
// it, because a wrong path is indistinguishable from a right one until someone
// installs the package.
//
// Two criteria, and the second is the one with teeth. A placeholder that the
// plugin rejects BY NAME is honest; an author path that merely fails to spawn
// teaches the consumer nothing. So the first check refuses to ship a real path,
// and the second requires the failure to actually name the cause and the fix —
// otherwise this could be "fixed" by shipping a plausible-looking path again
// and going straight back to the opaque spawn error.

const patchSource = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
const shippedDir = patchSource.match(/projectDir:\s*'([^']*)'/)?.[1] ?? null
const shippedIsReal = shippedDir !== null && existsSync(path.resolve(ROOT, shippedDir))
check('the shipped patch carries a placeholder, not a real machine path', !shippedIsReal,
  shippedDir === null ? 'no projectDir key found in cordis.patch.yml'
    : shippedIsReal ? `ships ${shippedDir}, which EXISTS on this machine — that is an author path`
      : `placeholder: ${shippedDir}`)

const { resolveProjectDir } = await import(pathToFileURL(path.join(ROOT, 'lib', 'project-dir.mjs')).href)
let refusal = ''
try {
  resolveProjectDir({ projectDir: path.join(ROOT, 'no-such-checkout') })
} catch (error) {
  refusal = String(error?.message ?? error)
}
check('a wrong projectDir is refused with an actionable message',
  refusal.includes('projectDir') && refusal.includes('checkout') && !refusal.includes('ENOENT'),
  refusal.length === 0 ? 'resolveProjectDir accepted a projectDir that does not exist'
    : refusal.includes('ENOENT') ? 'failed as a bare spawn error — names the mechanism, not the fix'
      : refusal.slice(0, 110))

// The happy path, which is what stops the check above from being satisfied by a
// guard that rejects everything. A criterion that only ever sees the failure
// branch cannot tell a working guard from one that throws on all input — and a
// plugin that refuses every checkout is exactly as broken as one that accepts
// every checkout, just less visibly.
const accepted = resolveProjectDir({ projectDir: PROJECT ?? ROOT })
check('a real MoonBit checkout is accepted', accepted === path.resolve(PROJECT ?? ROOT), accepted)

// --------------------------------------------------- claims that need the module

if (!PROJECT || !existsSync(PROJECT)) {
  console.log(`\n::error::PYRODUCT_PROJECT_DIR is not a directory: ${PROJECT}`)
  process.exit(1)
}

if (!existsSync(BRIDGE)) {
  const built = await run(MOON, ['build', '--target', 'js'], { cwd: PROJECT })
  check('the jsoncli bridge is available (built it if it was missing)', existsSync(BRIDGE),
    built.stderr.trim().split('\n').slice(-1)[0] ?? '')
}
if (!existsSync(BRIDGE)) {
  console.log(`\n::error::no bridge at ${BRIDGE}; cannot ask the module anything`)
  process.exit(1)
}

const replyRun = await run(process.execPath, [BRIDGE, JSON.stringify({ kind: 'report' })], { cwd: PROJECT })
let reply = null
try {
  reply = JSON.parse(replyRun.stdout.trim().split('\n').pop())
} catch {
  // reported below
}
check('the bridge answers with a parseable JSON envelope', reply !== null,
  (replyRun.stdout.trim().split('\n').pop() ?? replyRun.stderr).slice(0, 120))
check('the bridge reports ok', reply?.ok === true, String(reply?.error ?? ''))
check('the bridge actually rendered the face', typeof reply?.rendered === 'string' && reply.rendered.length > 0,
  `${String(reply?.rendered?.length ?? 0)} chars`)

const moduleFaces = Array.isArray(reply?.faces) ? reply.faces : []
const inModuleOnly = moduleFaces.filter((f) => !faces.includes(f))
const inPluginOnly = faces.filter((f) => !moduleFaces.includes(f))
check('FACES === the bridge faces() (no face the plugin cannot ask for)',
  inModuleOnly.length === 0,
  inModuleOnly.length > 0 ? `module has, plugin enum lacks: ${inModuleOnly.join(', ')}` : 'sets equal')
check('FACES === the bridge faces() (no face the module would reject)',
  inPluginOnly.length === 0,
  inPluginOnly.length > 0 ? `plugin enum claims, module lacks: ${inPluginOnly.join(', ')}` : 'sets equal')

// The test count is quoted in two places; both must match what `moon test` prints.
// AND the module's own suite must actually be green: this harness answers a
// question ABOUT the module, so a module whose tests are red must not be able to
// pass here. Checking only the count was a real hole — `moon test` prints
// "Total tests: N, passed: N, failed: 0." / "…passed: N-1, failed: 1.", both of
// which match the count regex, so a red suite was reported as a clean run. The
// count is the LAST question, not the only one.
const testRun = await run(MOON, ['test'], { cwd: PROJECT })
const testOutput = testRun.stdout + testRun.stderr
const realTotal = testOutput.match(/Total tests:\s*(\d+),\s*passed/)?.[1]
const failedCount = testOutput.match(/Total tests:\s*\d+,\s*passed:\s*\d+,\s*failed:\s*(\d+)/)?.[1]
check('the module test suite reports a total', Boolean(realTotal),
  realTotal ? `${realTotal} tests` : testOutput.trim().split('\n').slice(-1)[0]?.slice(0, 120))
check('the module test suite is green',
  testRun.code === 0 && failedCount === '0',
  testRun.code !== 0 ? `moon test exited ${testRun.code}` : failedCount === '0' ? 'exit 0, failed 0'
    : `moon test exited 0 but reported ${failedCount} failing test(s) — the count alone cannot tell a red suite from a green one`)
const realTotalNum = Number(realTotal)
for (const [where, source] of [['index.js', indexSource], ['README.md', readFileSync(path.join(ROOT, 'README.md'), 'utf8')]]) {
  const claim = [...source.matchAll(/(\d+)\s+tests/gi)].map((m) => Number(m[1]))
  check(`${where} quotes no stale test count`,
    claim.every((n) => n === realTotalNum),
    claim.length === 0 ? 'no count quoted'
      : claim.every((n) => n === realTotalNum) ? `${claim.join(', ')} matches ${realTotalNum}`
      : `quotes ${claim.join(', ')}, module runs ${realTotalNum}`)
}

console.log(`\n${checkCount} checks run`)
console.log(problems.length === 0
  ? `ALL CHECKS PASSED (${checkCount})`
  : `FAILURES (${checkCount - problems.length}/${checkCount} passed): ${problems.join(' | ')}`)
process.exit(problems.length === 0 ? 0 : 1)
