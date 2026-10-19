<#
.SYNOPSIS
  Print the 6-digit TOTP npm wants for `npm publish --otp=<code>`.

.DESCRIPTION
  npm's registry requires an OTP for writes when the account's 2FA mode is
  `auth-and-writes` (this account's is). The registry accepts either a 6-digit
  numeric code or a 64-character base32 secret, from which npm derives the
  code itself.

  This script implements RFC 6238 / RFC 4226 directly: base32-decode the
  secret, HOTP over the 30-second time counter, dynamic truncation, modulo.

  The base32 secret is the one npm showed when 2FA was enabled, and the one
  your authenticator app displays as its "setup key". It is NOT obtainable
  afterwards from npm itself -- `npm profile get` returns only
  {"pending":null,"mode":"auth-and-writes"}, with no secret field. To see it
  again, use the authenticator app's account details, or npmjs.com's
  2FA settings page.

  The secret is read from the environment, so it never lands in this file or
  in your shell history:

      $env:NPM_OTP_SECRET = '<your base32 secret>'
      .\tools\npm-otp.ps1

  Or pipe it straight into the publish:

      npm publish --otp=$(& .\tools\npm-otp.ps1)

.NOTES
  Verified against the RFC 6238 SHA-1 test vectors (secret
  "12345678901234567890", i.e. base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ):
  T=59 -> 287082, T=1111111109 -> 081804, T=1111111111 -> 050471,
  T=1234567890 -> 005924.
#>
function Get-NpmOtp {
  [CmdletBinding()]
  param(
    # The base32 secret. Read from the environment by default so it is not
    # echoed into shell history.
    [string] $Base32Secret = $env:NPM_OTP_SECRET,

    # How many digits to return.
    [ValidateRange(6, 10)]
    [int] $Digits = 6,

    # The TOTP time step, in seconds.
    [ValidateRange(15, 90)]
    [int] $Step = 30,

    # Unix timestamp to compute for. Defaults to now. Only useful for testing.
    [long] $Timestamp = 0
  )

  if ([string]::IsNullOrWhiteSpace($Base32Secret)) {
    throw "No base32 secret. Set `$env:NPM_OTP_SECRET, or pass -Base32Secret."
  }

  if ($Timestamp -eq 0) {
    $Timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  }

  # --- base32 -> bytes (RFC 4648, no padding) ---------------------------
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  $clean = ($Base32Secret.ToUpperInvariant() -replace '[^A-Z2-7]', '')
  if ($clean.Length -eq 0) {
    throw "The secret contains no base32 characters."
  }

  $bytes = New-Object byte[] ([int][math]::Ceiling($clean.Length * 5 / 8))
  $buffer = 0
  $bits = 0
  $index = 0
  foreach ($char in $clean.ToCharArray()) {
    $value = $alphabet.IndexOf($char)
    if ($value -lt 0) { continue }
    $buffer = ($buffer -shl 5) -bor $value
    $bits += 5
    if ($bits -ge 8) {
      $bits -= 8
      $bytes[$index] = [byte](($buffer -shr $bits) -band 0xFF)
      $index++
    }
  }

  # --- counter -> big-endian 8 bytes ------------------------------------
  $counter = [long][math]::Floor($Timestamp / $Step)
  $counterBytes = New-Object byte[] 8
  for ($i = 7; $i -ge 0; $i--) {
    $counterBytes[$i] = [byte]($counter -band 0xFF)
    $counter = $counter -shr 8
  }

  # --- HMAC-SHA1 --------------------------------------------------------
  $hmac = New-Object System.Security.Cryptography.HMACSHA1 (,$bytes)
  try {
    $hash = $hmac.ComputeHash($counterBytes)
  } finally {
    $hmac.Dispose()
  }

  # --- dynamic truncation (RFC 4226 section 5.4) ------------------------
  $offset = $hash[$hash.Length - 1] -band 0x0F
  $truncated = (($hash[$offset] -band 0x7F) -shl 24) -bor
                (($hash[$offset + 1] -band 0xFF) -shl 16) -bor
                (($hash[$offset + 2] -band 0xFF) -shl 8) -bor
                ($hash[$offset + 3] -band 0xFF)

  $modulus = [int][math]::Pow(10, $Digits)
  $code = $truncated % $modulus
  return $code.ToString().PadLeft($Digits, '0')
}

# Run it directly: print one code for the current 30-second window.
#
# The guard is `-ne '.'` and that is load-bearing. `$MyInvocation.InvocationName`
# is the script path when you run `.\npm-otp.ps1`, '&' when you call it, and
# '.' when you DOT-SOURCE it — so testing for equality with '.' would fire the
# main block on import, which then threw "no base32 secret" at whoever was
# merely trying to load the function. Dot-sourcing must define the function
# and nothing else.
#
# The code goes out via Write-Output, NOT Write-Host, and that distinction is
# the whole contract of this file. Write-Host writes to the HOST; in Windows
# PowerShell 5.1 that is the information stream, and `$(...)` does not capture
# it. So a script that printed its code with Write-Host looked perfect on
# screen and handed npm an EMPTY --otp= when used as
# `npm publish --otp=$(& .\tools\npm-otp.ps1)`. Only Write-Output reaches
# stdout, and only stdout is what `$(...)` captures.
#
# The countdown goes to the host on purpose: it is for a human watching the
# terminal, and it must never end up inside the captured value.
if ($MyInvocation.InvocationName -ne '.') {
  try {
    $code = Get-NpmOtp
  } catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "  (find the base32 secret in your authenticator app's account details)" -ForegroundColor DarkGray
    exit 1
  }
  Write-Output $code
  Write-Host ("(window ends in {0}s)" -f (30 - ([int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() % 30))) -ForegroundColor DarkGray
}
