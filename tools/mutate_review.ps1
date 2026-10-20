<#
.SYNOPSIS
  Mutation review for the publish-workflow criteria in tools/validate.mjs.

.DESCRIPTION
  A criterion that cannot go red is not a criterion. This harness re-introduces
  each way the publish workflow can be broken, one at a time, and requires the
  named criterion to FAIL every time. It exits 0 only when every mutation
  turned its criterion red, so it can gate CI rather than depend on somebody
  reading the output.

  The mutations are the ones an adversarial review actually found by mutating
  the workflow, not the ones the first version of the criteria was written
  against. The first version read the file as text and could not see structure;
  five classes of real breakage passed it:

    - a job-level `permissions: {}`, which REPLACES the top-level block;
    - the ordinary two-line step form (`- name: X` / `  uses: Y`);
    - a `tags:` filter moved under `pull_request:`;
    - a token written in an earlier step;
    - a file that is not valid YAML at all.

  Plus the two shape defects in the guard criteria (a "checkout" sub-check
  satisfied by the fixture's own path, and a happy path that died with an
  unhandled exception instead of naming the criterion).

  A mutation that fails to APPLY is reported as ERROR, never as a survivor. A
  harness that mutates by text substitution and does not check the anchor
  exists first will report "survived" for a mutation that never happened — and
  that is a claim about the tests when the truth is about the mutation.

.EXAMPLE
  powershell -NoProfile -File tools/mutate_review.ps1
#>
[CmdletBinding()]
param(
  # Where the working copy is made. Removed and recreated on every run.
  # Empty means "pick a temporary directory", and the pick is made in the
  # body rather than in the default value, because $env:TEMP does not exist
  # on Linux — the first CI run of this file died on a null path there.
  [string] $Work = '',

  # The module checkout the validator asks the module about. The gate sets
  # PYRODUCT_PROJECT_DIR; the default is the author's machine, and a wrong
  # one is reported as an error rather than silently skipped.
  [string] $ProjectDir = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Work)) {
  $tempRoot = if (-not [string]::IsNullOrWhiteSpace($env:TEMP)) {
    $env:TEMP
  } elseif (-not [string]::IsNullOrWhiteSpace($env:TMPDIR)) {
    $env:TMPDIR
  } else {
    [IO.Path]::GetTempPath()
  }
  $Work = Join-Path $tempRoot 'dsh-mutate-review'
}

if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
  $ProjectDir = if (-not [string]::IsNullOrWhiteSpace($env:PYRODUCT_PROJECT_DIR)) {
    $env:PYRODUCT_PROJECT_DIR
  } else {
    'D:\src\DeepseekHarness\Projects\pyroduct'
  }
}

# The shell that runs the OTP script. The gate runs on ubuntu, where the
# PowerShell that ships is pwsh; on Windows both may exist, and the Windows
# one is the one whose behaviour this file is really about.
$Shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }

# pwsh 7.4 turned native stderr into a terminating error when
# $ErrorActionPreference is Stop. This harness runs native commands that
# write to stderr on purpose (the OTP countdown), so that switch is turned
# off where it exists. It does not exist on Windows PowerShell 5.1.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$Repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
# The paths are joined one segment at a time, because a backslash is a
# separator on Windows and an ordinary character in a file name on Linux —
# a literal '.github\workflows\publish.yml' finds nothing there.
$Validate = Join-Path (Join-Path $Repo 'tools') 'validate.mjs'
$Publish = Join-Path (Join-Path (Join-Path $Repo '.github') 'workflows') 'publish.yml'
$Gate = Join-Path (Join-Path (Join-Path $Repo '.github') 'workflows') 'gate.yml'
$Guard = Join-Path (Join-Path $Repo 'lib') 'project-dir.mjs'

if (-not (Test-Path $Validate)) { throw "no validator at $Validate" }
if (-not (Test-Path $ProjectDir)) { throw "no module checkout at $ProjectDir" }

# Each mutation: a name, the file it touches, the anchor that must exist for
# the mutation to mean anything, the replacement, and the criterion that has
# to go red.
$Mutations = @(
  @{
    Name = 'job-level permissions: {} replaces the workflow-level block'
    File = $Publish
    Anchor = "jobs:`n  publish:`n    runs-on: ubuntu-latest"
    Replace = "jobs:`n  publish:`n    permissions: {}`n    runs-on: ubuntu-latest"
    Criterion = 'the publish job ends up with an OIDC identity'
  },
  @{
    Name = 'the two-line step form of uses:'
    File = $Publish
    Anchor = "      - name: Check out this repository`n"
    Replace = "      - name: Check out this repository`n        uses: actions/checkout@v5`n"
    Criterion = 'the publish workflow uses no third-party action'
  },
  @{
    Name = 'the tag filter moved under pull_request:'
    File = $Publish
    Anchor = "on:`n  push:`n    tags:`n      - 'v*'"
    Replace = "on:`n  push:`n  pull_request:`n    tags:`n      - 'v*'"
    Criterion = 'the publish workflow triggers on version tags'
  },
  @{
    Name = 'a token written into .npmrc in an earlier step'
    File = $Publish
    Anchor = "      - name: Resolve the registry index"
    Replace = "      - name: Resolve the registry index`n        run: echo `"//registry.npmjs.org/:_authToken=secret`" > .npmrc"
    Criterion = 'the publish workflow carries no token and no --otp'
  },
  @{
    Name = 'the workflow is not valid YAML'
    File = $Publish
    Anchor = "jobs:`n  publish:`n"
    Replace = "jobs:`n  publish: [`n"
    Criterion = 'the publish workflow parses into the expected shape'
  },
  @{
    Name = 'the id-token permission is deleted'
    File = $Publish
    Anchor = "  id-token: write # REQUIRED for OIDC`n"
    Replace = ""
    Criterion = 'the publish job ends up with an OIDC identity'
  },
  @{
    Name = 'the id-token permission is downgraded to read'
    File = $Publish
    Anchor = "  id-token: write # REQUIRED for OIDC`n"
    Replace = "  id-token: read`n"
    Criterion = 'the publish job ends up with an OIDC identity'
  },
  @{
    Name = 'the whole permissions block is deleted'
    File = $Publish
    Anchor = "permissions:`n  id-token: write # REQUIRED for OIDC`n  contents: read`n`n"
    Replace = ""
    Criterion = 'the publish job ends up with an OIDC identity'
  },
  @{
    Name = 'the Publish step is renamed'
    File = $Publish
    Anchor = "      - name: Publish`n"
    Replace = "      - name: Ship it`n"
    Criterion = 'the publish workflow has a step named Publish'
  },
  @{
    Name = 'the publish step is commented out'
    File = $Publish
    Anchor = "          npm stage publish`n"
    Replace = "          # npm stage publish`n"
    Criterion = 'the publish workflow stages the version for review'
  },
  @{
    Name = 'the publish step goes back to a direct publish'
    File = $Publish
    Anchor = "          npm stage publish`n"
    Replace = "          npm publish`n"
    Criterion = 'the publish workflow never publishes directly'
  },
  @{
    Name = 'the one-line step form of uses:'
    File = $Publish
    Anchor = "      - name: Check out this repository`n"
    Replace = "      - uses: actions/checkout@v5`n      - name: Check out this repository`n"
    Criterion = 'the publish workflow uses no third-party action'
  },
  @{
    Name = '--otp added to the publish step'
    File = $Publish
    Anchor = "          npm stage publish`n"
    Replace = "          npm stage publish --otp 123456`n"
    Criterion = 'the publish workflow carries no token and no --otp'
  },
  @{
    Name = 'NODE_AUTH_TOKEN added to the publish step'
    File = $Publish
    Anchor = "          npm stage publish`n"
    Replace = "          NODE_AUTH_TOKEN=secret npm stage publish`n"
    Criterion = 'the publish workflow carries no token and no --otp'
  },
  @{
    Name = 'the pinned npm is replaced by latest'
    File = $Publish
    Anchor = "npm install -g npm@11.21.1"
    Replace = "npm install -g npm@latest"
    Criterion = 'the workflow installs a pinned npm that can stage'
  },
  @{
    Name = 'the pinned npm is lowered below what can stage'
    File = $Publish
    Anchor = "npm install -g npm@11.21.1"
    Replace = "npm install -g npm@11.14.0"
    Criterion = 'the workflow installs a pinned npm that can stage'
  },
  @{
    Name = 'the npm floor is lowered below what can stage'
    File = $Publish
    Anchor = 'npm_min="11.15.0"'
    Replace = 'npm_min="11.5.1"'
    Criterion = 'the workflow refuses to run on an npm that cannot stage'
  },
  @{
    Name = 'the tag filter no longer matches version tags'
    File = $Publish
    Anchor = "      - 'v*'`n"
    Replace = "      - 'release*'`n"
    Criterion = 'the publish workflow triggers on version tags'
  },
  @{
    Name = 'the guard stops naming a checkout'
    File = $Guard
    Anchor = 'needs a real riantr/pyroduct checkout on THIS machine'
    Replace = 'needs a real riantr/pyroduct directory on THIS machine'
    Criterion = 'a wrong projectDir is refused with an actionable message'
  },
  @{
    Name = 'the guard throws on every input'
    File = $Guard
    Anchor = "export function resolveProjectDir(config) {`n"
    Replace = "export function resolveProjectDir(config) {`n  throw new Error('this guard rejects everything')`n"
    Criterion = 'a real MoonBit checkout is accepted'
  },
  @{
    Name = 'the gate stops running the validator'
    File = $Gate
    Anchor = "        run: node tools/validate.mjs`n"
    Replace = "        run: echo `"the validator is not wired in`"`n"
    Criterion = 'the gate runs the validator'
  },
  @{
    Name = 'the gate stops running the mutation review'
    File = $Gate
    Anchor = "        run: pwsh -NoProfile -File tools/mutate_review.ps1`n"
    Replace = "        run: echo `"the mutation review is not wired in`"`n"
    Criterion = 'the gate runs the mutation review'
  }
)

function Copy-Pristine {
  # A full copy of the repo, minus the git metadata, is the working tree the
  # mutations are applied to. The originals are never touched.
  if (Test-Path $Work) { Remove-Item -Recurse -Force $Work }
  New-Item -ItemType Directory -Path $Work | Out-Null
  foreach ($item in Get-ChildItem -Path $Repo -Force) {
    if ($item.Name -eq '.git') { continue }
    Copy-Item -Path $item.FullName -Destination $Work -Recurse -Force
  }
}

$env:PYRODUCT_PROJECT_DIR = $ProjectDir
$results = @()
$selfChecks = @()

# ------------------------------------------------------------- the OTP script
#
# The TOTP generator is the one file in this repository that computes
# something, so it gets the same treatment as the workflow: the RFC's own
# test vectors are the assertion, and the stdout contract is asserted by
# capturing it the way a caller would.
#
# The base32 secret of the RFC 6238 SHA-1 vectors is the well-known
# "12345678901234567890" in base32.
if (-not (Test-Path $Work)) { New-Item -ItemType Directory -Path $Work -Force | Out-Null }
$OtpScript = Join-Path $Repo 'tools\npm-otp.ps1'
$OtpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
$OtpVectors = @(
  @{ T = 59; Code = '287082' },
  @{ T = 1111111109; Code = '081804' },
  @{ T = 1111111111; Code = '050471' },
  @{ T = 1234567890; Code = '005924' },
  @{ T = 2000000000; Code = '279037' },
  @{ T = 20000000000; Code = '353130' }
)
foreach ($v in $OtpVectors) {
  $cmd = ". '$OtpScript'; Get-NpmOtp -Base32Secret '$OtpSecret' -Timestamp $($v.T)"
  $raw = (& $Shell -NoProfile -Command $cmd | Out-String)
  # The LAST non-empty line, not the whole output. If dot-sourcing ever ran
  # the script's main block as well, that block would print a code of its
  # own and the comparison would fail on the wrong line.
  $got = (($raw -split "`r?`n") | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 1)
  $got = if ($null -eq $got) { '' } else { $got.Trim() }
  $selfChecks += [pscustomobject]@{
    Check = "RFC 6238 vector T=$($v.T) is $($v.Code)"
    Verdict = $(if ($got -eq $v.Code) { 'PASS' } else { 'FAIL' })
    Detail = "expected $($v.Code), got '$got'"
  }
}

# The stdout contract, measured the way a caller hits it: a real run whose
# stdout is captured on its own.
#
# `Write-Host` in Windows PowerShell 5.1 reaches the redirected stdout, so a
# countdown printed that way would have been glued to the code and handed to
# npm as a two-line --otp value. Note the limit of this check honestly: under
# pwsh 7 `Write-Host` goes to the information stream and never reaches the
# captured stdout, so the OLD code would pass here too. The check asserts
# the contract on every shell; the shell that DISCRIMINATES is the Windows
# one, and that is where the defect was measured.
#
# The two runs below separate the streams WITHOUT redirecting stderr to a
# file. In Windows PowerShell 5.1 a native command that writes to stderr
# raises a NativeCommandError, which `2> file` turns into a terminating error
# under `$ErrorActionPreference = 'Stop'` — the harness died on the
# countdown it was trying to measure. So stderr is discarded in one run and
# merged in the other, and the preference is relaxed around both.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$env:NPM_OTP_SECRET = $OtpSecret
try {
  $otpStdoutText = & $Shell -NoProfile -File $OtpScript 2>$null
  $otpMergedText = & $Shell -NoProfile -File $OtpScript 2>&1
} finally {
  $ErrorActionPreference = $previousPreference
}
$otpStdout = (($otpStdoutText | Out-String)).Trim()
$otpMerged = (($otpMergedText | Out-String))
$selfChecks += [pscustomobject]@{
  Check = 'a captured stdout carries the code and nothing else'
  Verdict = $(if ($otpStdout -match '^\d{6}$') { 'PASS' } else { 'FAIL' })
  Detail = "stdout was '$otpStdout'"
}
$selfChecks += [pscustomobject]@{
  Check = 'the countdown is on the other stream, not stdout'
  Verdict = $(if ($otpMerged -match 'window ends in' -and $otpStdout -notmatch 'window ends in') { 'PASS' } else { 'FAIL' })
  Detail = "merged output was '$($otpMerged.Trim())'"
}
$env:NPM_OTP_SECRET = $null

foreach ($m in $Mutations) {
  Copy-Pristine
  $target = Join-Path $Work ($m.File.Substring($Repo.Length + 1))
  $original = [IO.File]::ReadAllText($m.File).Replace("`r`n", "`n")
  if (-not $original.Contains($m.Anchor)) {
    $results += [pscustomobject]@{
      Mutation = $m.Name; Criterion = $m.Criterion; Verdict = 'ERROR'
      Detail = 'the anchor was not found — the mutation never applied'
    }
    continue
  }
  $mutated = $original.Replace($m.Anchor, $m.Replace)
  if ($mutated -eq $original) {
    $results += [pscustomobject]@{
      Mutation = $m.Name; Criterion = $m.Criterion; Verdict = 'ERROR'
      Detail = 'the replacement was identical to the anchor'
    }
    continue
  }
  [IO.File]::WriteAllText($target, $mutated)

  # The validator is EXPECTED to exit non-zero here — that is what "the
  # criterion went red" looks like. So the preference that turns a native
  # command's failure into a terminating error is relaxed around it; the
  # verdict is read from the output, not from the exit code.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & node (Join-Path (Join-Path $Work 'tools') 'validate.mjs') 2>&1 | Out-String
    $exit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $line = ($output -split "`r?`n" | Where-Object { $_ -like "*$($m.Criterion)*" } | Select-Object -First 1)
  if ($null -eq $line) {
    $results += [pscustomobject]@{
      Mutation = $m.Name; Criterion = $m.Criterion; Verdict = 'ERROR'
      Detail = "the criterion was not reported at all (exit $exit)"
    }
    continue
  }
  $caught = $line.TrimStart().StartsWith('FAIL')
  $results += [pscustomobject]@{
    Mutation = $m.Name; Criterion = $m.Criterion
    Verdict = $(if ($caught) { 'CAUGHT' } else { 'SURVIVED' })
    Detail = $line.Trim()
  }
}

Write-Output ''
Write-Output 'self-check                                       verdict'
Write-Output '---------------------------------------------- --------'
foreach ($s in $selfChecks) {
  Write-Output ('{0,-46} {1}' -f $s.Check, $s.Verdict)
}
$selfFailed = @($selfChecks | Where-Object { $_.Verdict -ne 'PASS' }).Count
Write-Output ''

Write-Output 'mutation                                        verdict'
Write-Output '---------------------------------------------- --------'
foreach ($r in $results) {
  Write-Output ('{0,-46} {1}' -f $r.Mutation, $r.Verdict)
}
$caught = @($results | Where-Object { $_.Verdict -eq 'CAUGHT' }).Count
$survived = @($results | Where-Object { $_.Verdict -eq 'SURVIVED' }).Count
$errored = @($results | Where-Object { $_.Verdict -eq 'ERROR' }).Count
Write-Output ''
Write-Output "$caught caught, $survived survived, $errored errored, $($results.Count) total"
if ($selfFailed -gt 0) {
  Write-Output ''
  foreach ($s in $selfChecks | Where-Object { $_.Verdict -ne 'PASS' }) {
    Write-Output ("  FAIL: {0}" -f $s.Check)
    Write-Output ("    {0}" -f $s.Detail)
  }
}
if ($survived -gt 0 -or $errored -gt 0) {
  Write-Output ''
  foreach ($r in $results | Where-Object { $_.Verdict -ne 'CAUGHT' }) {
    Write-Output ("  {0}: {1}" -f $r.Verdict, $r.Mutation)
    Write-Output ("    {0}" -f $r.Detail)
  }
  exit 1
}
if ($selfFailed -gt 0) { exit 1 }
exit 0
