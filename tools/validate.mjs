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

// --------------------------------------------------------------- block structure
//
// A deliberately small reader for the block-style YAML a workflow file is
// written in. It is not a YAML parser and does not pretend to be: it handles
// block mappings, block sequences and block scalars, and stops there.
//
// What it buys is the one thing a regex cannot have: the answer to "which
// key is this nested under?". Every question the publish checks ask is a
// question about POSITION — is `id-token: write` in the top-level
// `permissions:` block or in a job-level one that REPLACES it? Is `tags:`
// under `on: push:` or under `on: pull_request:`? — and position is exactly
// what a flat text search throws away.
//
// Block scalars (`run: |`) are why this exists rather than another regex. A
// shell body is opaque text: `echo "a: b"` is not a mapping, and a `#` in it
// is not a comment. The reader keeps a scalar's contents out of the
// structure entirely, so what the structure shows is the workflow's own
// shape.
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (quote !== null) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

function readStructure(source) {
  const raw = source.split('\n').map(stripComment)
  let pos = 0

  const head = () => {
    while (pos < raw.length) {
      const text = raw[pos].trim()
      if (text === '') { pos += 1; continue }
      return { indent: raw[pos].length - raw[pos].trimStart().length, text }
    }
    return null
  }

  const skipScalar = (headerIndent) => {
    while (pos < raw.length) {
      const line = raw[pos]
      if (line.trim() === '') { pos += 1; continue }
      if (line.length - line.trimStart().length <= headerIndent) break
      pos += 1
    }
  }

  const scalar = (text) => {
    const t = text.trim()
    if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
      return t.slice(1, -1)
    }
    return t
  }

  const node = (minIndent) => {
    const first = head()
    if (first === null || first.indent < minIndent) return undefined
    if (first.text === '-' || first.text.startsWith('- ')) {
      const items = []
      for (;;) {
        const cur = head()
        if (cur === null || cur.indent !== first.indent) break
        if (cur.text !== '-' && !cur.text.startsWith('- ')) break
        const rest = cur.text === '-' ? '' : cur.text.slice(2).trim()
        if (rest === '') {
          pos += 1
          items.push(node(first.indent + 1) ?? null)
          continue
        }
        if (/^[^:]+:(\s|$)/.test(rest)) {
          // `- name: X` — the item is a mapping whose first key sits two
          // columns in. Rewrite the line so the mapping reader sees it.
          raw[pos] = ' '.repeat(first.indent + 2) + rest
          items.push(node(first.indent + 2) ?? null)
          continue
        }
        pos += 1
        items.push(scalar(rest))
      }
      return items
    }
    const map = {}
    for (;;) {
      const cur = head()
      if (cur === null || cur.indent !== first.indent) break
      if (cur.text === '-' || cur.text.startsWith('- ')) break
      const m = cur.text.match(/^([^:]+):\s*(.*)$/)
      if (m === null) { pos += 1; continue }
      pos += 1
      const key = m[1].trim().replace(/^["']|["']$/g, '')
      const value = m[2].trim()
      if (value === '') {
        map[key] = node(first.indent + 1) ?? null
        continue
      }
      if (/^[|>][-+]?\d*$/.test(value)) {
        skipScalar(cur.indent)
        map[key] = null
        continue
      }
      map[key] = scalar(value)
    }
    return map
  }

  return node(0) ?? {}
}

// Every occurrence of a key, at any depth. Used for `uses:` — a third-party
// action is a third-party action wherever it is written, and the first
// version of that check only saw the one-line step form.
function collectKeys(node, key, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, key, found)
    return found
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) found.push(v)
      collectKeys(v, key, found)
    }
  }
  return found
}

// ------------------------------------------------- the publish workflow's shape
//
// The publish workflow fails SILENTLY when it is wrong, in three different
// ways, and none of them is visible until a tag is pushed:
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
//   3. A tag that does not match package.json's version is refused by npm
//      with E403, which reads like a permissions problem rather than a
//      version mismatch.
//
// These are properties of a file no other check looked at, and the tag that
// would expose them is pushed rarely. So they are checked here, on every
// push.
//
// The first version of these checks read the file as TEXT, and a text check
// cannot see structure. Five ways of breaking the workflow therefore passed
// every criterion:
//
//   - a job-level `permissions: {}` — which REPLACES the top-level block, so
//     OIDC dies while the top-level `id-token: write` is still there to be
//     found;
//   - the ordinary two-line step form (`- name: X` / `  uses: Y`), invisible
//     to a pattern that wanted the dash and the `uses:` on one line;
//   - a `tags:` filter moved under `pull_request:`, where the workflow never
//     fires on a tag push at all;
//   - a token written in an EARLIER step, which the publish-step-only scan
//     never looked at;
//   - a file that is not valid YAML, which GitHub refuses to run and every
//     text check waves through.
//
// So the checks below read the BLOCK STRUCTURE, not the text.
const publishPath = path.join(ROOT, '.github', 'workflows', 'publish.yml')
const publishExists = existsSync(publishPath)
check('a publish workflow exists', publishExists, publishExists ? '.github/workflows/publish.yml' : 'missing')
if (publishExists) {
  const publishSource = readFileSync(publishPath, 'utf8')
  const tree = readStructure(publishSource)
  // Comments are stripped before anything is matched, but their removal is
  // not the reason the checks below are safe from a good comment. The header
  // of this workflow NAMES `id-token: write` to explain that the permission
  // is what the whole mechanism rests on — and the first version of that
  // criterion passed with the permission deleted, because the explanation in
  // the comment still said the words.
  const publishCode = publishSource.split('\n').map(stripComment).join('\n')
  const jobNames = tree.jobs && typeof tree.jobs === 'object' && !Array.isArray(tree.jobs)
    ? Object.keys(tree.jobs)
    : []
  const job = jobNames.length === 1 ? tree.jobs[jobNames[0]] : null
  const tabs = publishSource.split('\n').filter((l) => /^[ ]*\t/.test(l))

  // 1. The file has to BE a workflow. GitHub refuses to run a file it cannot
  //    parse, and a workflow that never runs reports success in every
  //    dashboard it appears in.
  const shapeProblems = []
  if (!tree.on) shapeProblems.push('no `on:` trigger')
  if (jobNames.length !== 1) shapeProblems.push(`expected exactly one job, found ${jobNames.length}`)
  if (job !== null && !job['runs-on']) shapeProblems.push('the job has no `runs-on`')
  if (job !== null && !(Array.isArray(job.steps) && job.steps.length > 0)) shapeProblems.push('the job has no steps')
  if (tabs.length > 0) shapeProblems.push(`${tabs.length} line(s) indent with a tab`)
  check('the publish workflow parses into the expected shape', shapeProblems.length === 0,
    shapeProblems.length === 0 ? `${jobNames.length} job, ${job && Array.isArray(job.steps) ? job.steps.length : 0} steps`
      : shapeProblems.join('; '))

  // 2. The OIDC identity. GitHub's rule is that a job-level `permissions:`
  //    block REPLACES the workflow-level one rather than adding to it, so
  //    the effective permission is the job's if it has one, and the
  //    workflow's only if it does not. A job-level `permissions: {}` is
  //    therefore the same as no OIDC at all.
  const workflowPerms = tree.permissions && typeof tree.permissions === 'object' && !Array.isArray(tree.permissions)
    ? tree.permissions
    : null
  const jobHasPerms = job !== null && typeof job === 'object'
    && Object.prototype.hasOwnProperty.call(job, 'permissions')
  const effectivePerms = jobHasPerms ? job.permissions : workflowPerms
  const effectiveIdToken = effectivePerms && typeof effectivePerms === 'object' && !Array.isArray(effectivePerms)
    ? effectivePerms['id-token']
    : undefined
  check('the publish job ends up with an OIDC identity', effectiveIdToken === 'write',
    effectiveIdToken === 'write' ? 'id-token: write'
      : jobHasPerms ? 'the job-level permissions block replaces the workflow-level one, and it grants no id-token'
        : workflowPerms === null ? 'no permissions block at all'
          : 'the workflow permissions block grants no id-token')

  // 3. No third-party action, in any of the forms a step can take.
  const usesRefs = collectKeys(tree, 'uses').filter((v) => typeof v === 'string')
  check('the publish workflow uses no third-party action',
    usesRefs.length === 0,
    usesRefs.length === 0 ? 'plain git, as the Actions policy requires'
      : `would be rejected at job setup: ${usesRefs.join(', ')}`)

  // 4. The trigger, read as a trigger: the tag filter has to sit under
  //    `on: push:`. A `tags:` under `pull_request:` looks identical in a
  //    text search and fires on a completely different event.
  const pushTags = tree.on && tree.on.push && Array.isArray(tree.on.push.tags) ? tree.on.push.tags : []
  check('the publish workflow triggers on version tags', pushTags.includes('v*'),
    pushTags.length === 0 ? '`on: push:` carries no tag filter'
      : pushTags.includes('v*') ? "on: push: tags: 'v*'"
        : `on: push: tags: ${pushTags.join(', ')}`)

  // 5. No token anywhere in the file. This used to look only at the text
  //    after the step named "Publish", which is a hole in three ways: a
  //    token in an earlier step, a token at job level in `env:`, and a
  //    step RENAMED away from "Publish" (which made the scanned text empty,
  //    so the check passed on nothing at all).
  const tokenish = ['--otp', 'NODE_AUTH_TOKEN', '_authToken'].filter((t) => publishCode.includes(t))
  check('the publish workflow carries no token and no --otp',
    tokenish.length === 0,
    tokenish.length === 0 ? 'OIDC only — the CLI authenticates itself'
      : `mentions ${tokenish.join(', ')}`)

  // 6. The step that publishes exists, and it is the step that publishes.
  //    Without these two, everything above can be satisfied by a workflow
  //    that never reaches npm.
  const stepNames = job && Array.isArray(job.steps)
    ? job.steps.map((s) => (s && typeof s === 'object' ? s.name : null)).filter((n) => typeof n === 'string')
    : []
  check('the publish workflow has a step named Publish', stepNames.includes('Publish'),
    stepNames.length === 0 ? 'the job has no named steps'
      : stepNames.includes('Publish') ? stepNames.join(' | ')
        : `steps are: ${stepNames.join(' | ')}`)
  check('the publish workflow actually runs npm publish', /^\s*npm publish\s*$/m.test(publishCode),
    /^\s*npm publish\s*$/m.test(publishCode) ? 'npm publish is there'
      : 'no `npm publish` command anywhere in the file')
}

// ------------------------------------------------- the gate's own wiring
//
// The criteria above are only worth something if the gate actually runs them,
// and the mutation review is what proves the criteria can fail at all. A
// check on the wiring of another check is a small thing, but it is the
// difference between "the gate checks this" and "somebody checked this once".
//
// The match is anchored to a `run:` line, not to the file's text. A criterion
// that is satisfied by a sentence explaining what the gate does is a
// criterion that a comment can keep green after the step is deleted.
const gatePath = path.join(ROOT, '.github', 'workflows', 'gate.yml')
const gateExists = existsSync(gatePath)
check('a gate workflow exists', gateExists, gateExists ? '.github/workflows/gate.yml' : 'missing')
if (gateExists) {
  const gateSource = readFileSync(gatePath, 'utf8')
  const gateCode = gateSource.split('\n').map(stripComment).join('\n')
  // The pattern is built from a ready-made regex fragment, so it is NOT
  // escaped again here: escaping a fragment that already carries its own
  // backslashes turns `validate\.mjs` into a pattern that demands a literal
  // backslash — and a criterion that can never pass is a criterion that
  // teaches its reader to ignore it.
  const gateRuns = (fragment) => new RegExp(`^\\s*run:.*${fragment}`, 'm').test(gateCode)
  check('the gate runs the validator', gateRuns('validate\\.mjs'),
    gateRuns('validate\\.mjs') ? 'a run: line invokes it' : 'no run: line invokes tools/validate.mjs')
  check('the gate runs the mutation review', gateRuns('mutate_review\\.ps1'),
    gateRuns('mutate_review\\.ps1') ? 'a run: line invokes it' : 'no run: line invokes tools/mutate_review.ps1')
}

// The project dir is needed by the module-dependent checks at the bottom and
// by the happy path just below. It is required, so it is checked FIRST: a
// missing one used to reach the happy path and throw out of the harness with
// a stack trace, instead of the sentence below that says what to set.
if (!PROJECT || !existsSync(PROJECT)) {
  console.log(`\n::error::PYRODUCT_PROJECT_DIR is not a directory: ${PROJECT}`)
  process.exit(1)
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
// The fixture path deliberately does NOT contain the word "checkout". The
// guard quotes the offending path back in its message, so a fixture that
// contained the word would satisfy the "the message names a checkout" half
// of the criterion by itself — the first version of this check used exactly
// such a fixture (`no-such-checkout`), which made the half of it that has
// teeth a no-op: deleting the word from the guard's message left the check
// green.
const missingDir = path.join(ROOT, 'no-such-dir')
let refusal = ''
try {
  resolveProjectDir({ projectDir: missingDir })
} catch (error) {
  refusal = String(error?.message ?? error)
}
// The path is removed before the message is judged, so the words that count
// are the ones the guard wrote rather than the ones in the path it echoed.
const refusalBody = refusal.split(path.resolve(missingDir)).join('')
check('a wrong projectDir is refused with an actionable message',
  refusalBody.includes('projectDir') && refusalBody.includes('checkout') && !refusalBody.includes('ENOENT'),
  refusal.length === 0 ? 'resolveProjectDir accepted a projectDir that does not exist'
    : refusalBody.includes('ENOENT') ? 'failed as a bare spawn error — names the mechanism, not the fix'
      : refusalBody.slice(0, 110))

// The happy path, which is what stops the check above from being satisfied by a
// guard that rejects everything. A criterion that only ever sees the failure
// branch cannot tell a working guard from one that throws on all input — and a
// plugin that refuses every checkout is exactly as broken as one that accepts
// every checkout, just less visibly.
//
// It is wrapped, because a guard that throws on EVERY input used to kill this
// criterion with an unhandled exception: the harness exited non-zero (right)
// but named no criterion (useless — a reader could not tell which check had
// failed, and the failure criterion above had already been satisfied).
let accepted = null
let acceptDetail = ''
try {
  accepted = resolveProjectDir({ projectDir: PROJECT })
  acceptDetail = accepted
} catch (error) {
  acceptDetail = String(error?.message ?? error).slice(0, 110)
}
check('a real MoonBit checkout is accepted', accepted !== null && accepted === path.resolve(PROJECT),
  accepted === null ? `the guard refused a real checkout: ${acceptDetail}` : accepted)

// --------------------------------------------------- claims that need the module

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
