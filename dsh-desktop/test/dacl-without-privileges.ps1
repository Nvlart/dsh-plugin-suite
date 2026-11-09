$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DirectorPrivilegeTest {
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, IntPtr state, uint length, IntPtr previous, IntPtr returned);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static void DisableForThisTestProcess() {
  IntPtr token;
  if(!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle,0x28,out token)) throw new System.ComponentModel.Win32Exception();
  try { if(!AdjustTokenPrivileges(token,true,IntPtr.Zero,0,IntPtr.Zero,IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(); }
  finally { CloseHandle(token); }
 }
}
'@
# This temporary test process only; no user rights or system policy is changed.
[DirectorPrivilegeTest]::DisableForThisTestProcess()
& (Join-Path $PSScriptRoot '..\manage-tunnel.ps1') -Action SelfTest
