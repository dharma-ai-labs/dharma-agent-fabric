// The check and write share one Windows process/thread and kernel mutex. WSL
// invokes the same helper, so the Windows token SID and vault account (not Linux
// UID, home or PID namespace) define the exclusion boundary.
export const windowsEnrollmentAnchorWrite = String.raw`
$ErrorActionPreference="Stop"
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$mutex=$null; $owned=$false
try {
  $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.account -cnotmatch '^device-enrollment-[a-f0-9]{32}$' -or
      $request.legacyAccount -cnotmatch '^device-enrollment-[a-f0-9]{32}$' -or
      $request.account -ceq $request.legacyAccount) {throw "Invalid anchor accounts"}
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=[Security.AccessControl.MutexSecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule([Security.AccessControl.MutexAccessRule]::new(
    $sid,[Security.AccessControl.MutexRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
  $created=$false
  $mutex=[Threading.Mutex]::new($false,("Global\DharmaFabricEnrollment-"+$sid.Value+"-"+$request.legacyAccount),[ref]$created,$acl)
  $actualAcl=$mutex.GetAccessControl()
  if ($actualAcl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid -or
      !$actualAcl.AreAccessRulesProtected) {throw "Unsafe anchor mutex"}
  foreach ($rule in $actualAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $rule.IdentityReference -ne $sid) {throw "Unsafe anchor mutex"}
  }
  try {$owned=$mutex.WaitOne(2000)}
  catch {
    if ($_.Exception.GetBaseException() -is [Threading.AbandonedMutexException]) {$owned=$true}
    throw
  }
  if (!$owned) {throw "Anchor busy"}
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $vault=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()
  function ReadAnchor($account) {
    try {
      $credential=$vault.Retrieve("Dharma Agent Fabric",$account)
      $credential.RetrievePassword()
      return $credential.Password
    } catch {
      if ($_.Exception.GetBaseException().HResult -eq -2147023728) {return $null}
      throw
    }
  }
  $current=ReadAnchor $request.account; $legacy=ReadAnchor $request.legacyAccount
  if (![string]::Equals($current,$request.expectedCurrent,[StringComparison]::Ordinal) -or
      ![string]::Equals($legacy,$request.expectedLegacy,[StringComparison]::Ordinal)) {
    [Console]::Out.Write("conflict")
  } else {
    $credential=[Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]::new(
      "Dharma Agent Fabric",$request.account,$request.secret)
    # Never remove the previous anchor before Add. Unsupported replacement or
    # failure stays fail-closed, without deliberately creating an absent slot.
    $vault.Add($credential)
    if (![string]::Equals((ReadAnchor $request.account),$request.secret,[StringComparison]::Ordinal)) {
      throw "Anchor write unconfirmed"
    }
    [Console]::Out.Write("written")
  }
} catch {
  [Console]::Error.Write("Enrollment anchor operation failed.")
  exit 1
} finally {
  if ($owned) {$mutex.ReleaseMutex()}
  if ($null -ne $mutex) {$mutex.Dispose()}
}
`;
