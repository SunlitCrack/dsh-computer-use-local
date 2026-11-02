$ErrorActionPreference = 'Stop'

# Load the production functions without running the UIA bootstrap or dispatcher.
# The C# types below contain no native imports and cannot send desktop input.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class CuNative {
  public static IntPtr Foreground = new IntPtr(101);
  public static int AlternateLookups;
  public static IntPtr GetForegroundWindow() { return Foreground; }
  public static int GetWindowThreadProcessId(IntPtr h, out uint pid) { pid = 42; return 1; }
  public static bool IsWindowVisible(IntPtr h) { return true; }
  public static IntPtr FindFirstWindowOfProcess(uint pid) { AlternateLookups++; return new IntPtr(202); }
}
namespace System.Windows.Automation {
  public class TestPattern { public string ProgrammaticName = "InvokePatternIdentifiers.Pattern"; }
  public static class InvokePattern { public static readonly object Pattern = new TestPattern(); }
  public static class AutomationElement {
    public static bool FailRequestedWindow;
    public static bool ReturnNull;
    public static int FailuresRemaining;
    public static int InvokeCount;
    public static long LastInvokedHwnd;
    public static List<long> Lookups = new List<long>();
    // Identity-recovery cases need a tree where the positional path is dead but
    // a named element exists. When set, children are produced under this name
    // so Find-ElementByIdentity has something to match; null means "no match".
    public static string IdentityChildName;
    // Drift cases need the OPPOSITE shape: the path still resolves, but onto an
    // element whose identity differs, with the real one sitting beside it. That
    // is the branch uia.ps1:1628 handles, and it cannot be reached with an
    // unresolvable path (that is :1624).
    public static string DriftDecoyName;
    // Whether this node reports children at all. Real providers return nothing
    // below a leaf; defaulting to "always has children" made the kernel's
    // leaf-at-depth-limit check (which asks FindFirst) fire for every node.
    public static bool HasChildren = true;
    public static TestElement FromHandle(IntPtr h) {
      Lookups.Add(h.ToInt64());
      if (h.ToInt64() == 101 && (FailRequestedWindow || FailuresRemaining-- > 0))
        throw new InvalidOperationException("UIA unavailable for requested window");
      return ReturnNull ? null : new TestElement(h.ToInt64());
    }
  }
  public class TestRect { public double X = 10, Y = 20, Width = 80, Height = 30; }
  public class TestCurrent {
    public TestRect BoundingRectangle = new TestRect();
    public long NativeWindowHandle;
    public string Name = "fixture", AutomationId = "fixture";
    public bool IsEnabled = true, IsOffscreen = false;
  }
  public class TestElement {
    public TestCurrent Current;
    public TestElement(long hwnd) { Current = new TestCurrent { NativeWindowHandle = hwnd }; }
    public TestElement(long hwnd, string name) {
      Current = new TestCurrent { NativeWindowHandle = hwnd, Name = name, AutomationId = name };
    }
    public object[] GetSupportedPatterns() { return new object[] { InvokePattern.Pattern }; }
    public TestInvoke GetCurrentPattern(object pattern) { return new TestInvoke(Current.NativeWindowHandle); }
    // Identity lookup walks children; expose the configured child (if any) so a
    // recovery case has a tree to search instead of an empty stub.
    //
    // Scope matters and used to be ignored: the kernel calls FindAll with
    // Children everywhere except one Descendants lookup (uia.ps1:1738), and a
    // mock that answers anything regardless of scope cannot catch a wrong scope.
    // Real providers also return nothing below a leaf -- answering with a child
    // for EVERY node made the kernel's "does this element have children?" check
    // always true, which is what the lazy-tree retry keys on.
    public ChildCollection FindAll(TreeScope scope, Condition condition) {
      var items = new List<TestElement>();
      // Only Children and Descendants ask for children. Subtree = 7 includes
      // Element(1), so testing Subtree too made a bare Element scope return a
      // child -- real UIA returns nothing for Element (it is the element itself).
      if ((scope & (TreeScope.Children | TreeScope.Descendants)) == 0)
        return new ChildCollection(items);
      if (!AutomationElement.HasChildren) return new ChildCollection(items);
      // Drift shape: ordinal 0 is a decoy (wrong identity, but the path still
      // resolves onto it) and ordinal 1 carries the expected identity. That is
      // the branch uia.ps1:1628 handles; an unresolvable path takes :1624
      // instead, which is a different branch and a different message.
      if (!string.IsNullOrEmpty(AutomationElement.DriftDecoyName)) {
        items.Add(new TestElement(Current.NativeWindowHandle, AutomationElement.DriftDecoyName));
        if (!string.IsNullOrEmpty(AutomationElement.IdentityChildName))
          items.Add(new TestElement(Current.NativeWindowHandle, AutomationElement.IdentityChildName));
        return new ChildCollection(items);
      }
      if (!string.IsNullOrEmpty(AutomationElement.IdentityChildName))
        items.Add(new TestElement(Current.NativeWindowHandle, AutomationElement.IdentityChildName));
      return new ChildCollection(items);
    }
    public TestElement FindFirst(TreeScope scope, Condition condition) {
      // Only Children and Descendants ask for children. Subtree = 7 includes
      // Element(1), so testing Subtree too made a bare Element scope return a
      // child -- real UIA returns nothing for Element (it is the element itself).
      if ((scope & (TreeScope.Children | TreeScope.Descendants)) == 0)
        return null;
      if (!AutomationElement.HasChildren) return null;
      if (!string.IsNullOrEmpty(AutomationElement.DriftDecoyName))
        return new TestElement(Current.NativeWindowHandle, AutomationElement.DriftDecoyName);
      if (!string.IsNullOrEmpty(AutomationElement.IdentityChildName))
        return new TestElement(Current.NativeWindowHandle, AutomationElement.IdentityChildName);
      return null;
    }
  }
  // Values and [Flags] follow the real UI Automation enum; the fixture previously
  // used Children=0, which no real provider returns and which made any
  // scope-sensitive assertion meaningless.
  [System.Flags]
  public enum TreeScope { Element = 1, Children = 2, Descendants = 4, Parent = 8, Ancestors = 16, Subtree = 7 }
  public class Condition { public static readonly Condition TrueCondition = new Condition(); }
  public class ChildCollection : List<TestElement> {
    public ChildCollection() { }
    public ChildCollection(IEnumerable<TestElement> items) : base(items) { }
  }
  public class TestInvoke {
    long hwnd;
    public TestInvoke(long h) { hwnd = h; }
    public void Invoke() { AutomationElement.InvokeCount++; AutomationElement.LastInvokedHwnd = hwnd; }
  }
}
'@

$kernelPath = Join-Path $PSScriptRoot '..\..\lib\uia.ps1'
$parseTokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $kernelPath).Path, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Kernel parse failed' }
$functions = @('Fail', 'Resolve-ElementByPath', 'Get-AutomationRoot', 'Invoke-Action', 'Invoke-GetState',
  # P3 added element-identity handling: Invoke-Action calls these, so the fixture
  # must load them or every case dies with "Test-ElementIdentity is not
  # recognized" (5 cases were red from P3 until this line).
  'Test-ElementIdentity', 'Get-ElementIdentity',
  # Recovering a drifted path by identity needs this lookup. It is pure (walks
  # the tree, returns an element), so the real implementation is safe to load --
  # without it the P3 recovery path could not be exercised at all.
  'Find-ElementByIdentity',
  # Pure key-chord parsing; no input is sent.
  'Convert-KeyChord')
foreach ($definition in $ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true)) {
  if ($functions -contains $definition.Name) { Invoke-Expression $definition.Extent.Text }
}

# --- isolation guard -------------------------------------------------------
# What keeps this fixture from typing into real windows is that the kernel's
# input types simply do not exist here: extraction runs only FUNCTION BODIES, so
# the top-level Add-Type / Add-Type -AssemblyName lines in lib/uia.ps1 never
# execute, and [CuInput], [System.Windows.Forms.SendKeys] and [System.Drawing]
# are absent.
#
# That is an accident, not a decision, so it is asserted explicitly. Two lessons
# from review are baked in:
#
#   1. Checking ONCE at load time is not enough. Appending an Add-Type after this
#      block loaded the assembly with the guard already satisfied, and the suite
#      stayed green while Invoke-Action typed into the real desktop (measured:
#      4 key events). The check therefore runs before EVERY case, via
#      Assert-Isolation below, called from Capture-Outcome.
#   2. A name list is not enough either. The real CuNative carries SetCursorPos
#      and keybd_event; a mock that grew SetCursorPos would pass a four-name
#      check and still move the real pointer (measured: 4 mouse events). What
#      matters is the CAPABILITY, so every public method on the mock is inspected
#      and any input-shaped name is rejected -- and the inspection uses
#      GetMethods(), because GetMethod(name) throws AmbiguousMatchException on
#      overloads and the old `catch {}` turned that into a silent pass.
$script:ForbiddenTypes = @(
  'CuInput',                       # SendMouse / SendKey / SendUnicode / VkFromChar
  'System.Windows.Forms.SendKeys', # SendWait
  'System.Drawing.Bitmap'          # CopyFromScreen target
)
$script:ForbiddenMembers = @(
  # Anything that could move the pointer, press a key, or paste.
  'keybd_event', 'mouse_event', 'SendInput', 'SetCursorPos',
  'SendKey', 'SendUnicode', 'SendMouse', 'SendKeys', 'SendWait', 'CopyFromScreen'
)

# ComSentKeys: a COM-based bypass that the type checks above cannot see.
# through a late-bound COM object: no assembly is loaded, no PowerShell type
# appears, and the kernel itself never uses COM today (verified) -- so this is a
# guard against a FUTURE edit, not a live hole.
#
# The check is a source scan, not a runtime probe, on purpose: creating the COM
# object just to see whether it exists would itself be a side effect, and this
# machine can create it (verified), so a probe would abort every run here.
function Assert-NoComInput {
  $source = [System.IO.File]::ReadAllText($PSCommandPath)
  # Strip this function's own body first: the patterns below are string literals
  # that live in the file being scanned, so a naive scan always matches itself.
  $marker = 'function Assert-NoComInput'
  $start = $source.IndexOf($marker)
  if ($start -ge 0) {
    $end = $source.IndexOf("`nfunction Assert-Isolation", $start)
    if ($end -gt $start) {
      $source = $source.Substring(0, $start) + $source.Substring($end)
    }
  }
  $patterns = @(
    'New-Object\s+-ComObject\s+WScript\.Shell',
    'WScript\.Shell',
    "InvokeMember\s*\(\s*'SendKeys'",
    "InvokeMember\s*\(\s*`"SendKeys`""
  )
  foreach ($pattern in $patterns) {
    if ($source -match $pattern) {
      throw ("fixture isolation broken: this fixture references COM input ($pattern). " +
        'WScript.Shell SendKeys sends real keystrokes through late binding -- the type checks ' +
        'cannot see it, so it is banned outright.')
    }
  }
  return 'ok'
}

function Assert-Isolation {
  # Count every invocation. A guard whose removal no test notices is a comment;
  # the counter is what lets a case prove the check actually RAN rather than
  # merely having been written.
  $script:IsolationRuns = 1 + [int]$script:IsolationRuns
  $null = Assert-NoComInput
  foreach ($name in $script:ForbiddenTypes) {
    $available = $false
    try { $null = [type]$name; $available = $true } catch { }
    if ($available) {
      throw ("fixture isolation broken: [$name] is available in this process, so the loaded kernel " +
        'could send real input or capture the real screen. Do not load those assemblies here; stub ' +
        'the helper instead (see Invoke-ClickAt / Invoke-Scroll).')
    }
  }
  # Capability, not name: enumerate every method the mock exposes. GetMethod(name)
  # is not usable here -- it throws on overloads and the exception used to be
  # swallowed, letting an input method survive the check.
  $methods = @([CuNative].GetMethods() | ForEach-Object { $_.Name })
  foreach ($member in $script:ForbiddenMembers) {
    if ($methods -contains $member) {
      throw ("fixture isolation broken: the mock [CuNative] exposes '$member'; it must stay " +
        'query-only, or the loaded kernel could send real input through it.')
    }
  }
  # A non-mock CuNative would mean lib/uia.ps1's own definition leaked in.
  if (@($methods).Count -gt 0 -and $methods -notcontains 'GetForegroundWindow') {
    throw 'fixture isolation broken: [CuNative] is not this fixture''s mock (missing GetForegroundWindow).'
  }
  return 'ok'
}

# Fail fast at load time too, so an obvious mistake aborts before the cases run.
$script:IsolationGuard = Assert-Isolation

function Start-Sleep { param($Milliseconds) }
function Resolve-Window { param($target) return [IntPtr]101 }
function Get-WindowRectArr { param($hwnd) return @{ x = 0; y = 0; width = 800; height = 600 } }
function Get-ProcessInfo { param($hwnd) return @{ pid = 42; processName = 'fixture' } }
function Activate-Window {
  param($hwnd)
  $script:ActivationAttempts++
  if ($script:ActivationSucceeds) { [CuNative]::Foreground = $hwnd; return $true }
  return $false
}
function Invoke-ClickAt {
  param($x, $y, $button, $count)
  $script:PointerCalls += @{ x = $x; y = $y; button = $button; count = $count }
}
function Invoke-TypeText {
  param($text)
  $script:TypedInto = [CuNative]::GetForegroundWindow().ToInt64()
  return $null
}
# Action helpers Invoke-Action calls that would otherwise reach real input.
# Stubbed (not loaded from the kernel) for the same reason Invoke-ClickAt is:
# the point is to test the decision logic, not to drive the desktop. Each one
# records what it was asked to do so a case can assert on it.
function Invoke-SecondaryAction {
  param($element, $action)
  $script:SecondaryCalls += @{ action = $action }
  return @{ ok = $true; via = "$action" + 'Pattern' }
}
function Invoke-Scroll {
  param($x, $y, $direction, $amount)
  $script:ScrollCalls += @{ x = $x; y = $y; direction = $direction; amount = $amount }
}
function Invoke-Drag {
  param($fromX, $fromY, $toX, $toY, $button)
  $script:DragCalls += @{ fromX = $fromX; fromY = $fromY; toX = $toX; toY = $toY; button = $button }
}
# Pure: turns a key chord into vk codes. Loading the real one is harmless and
# keeps the fixture honest about what the kernel does with key syntax.

function Reset-Fixture {
  [CuNative]::Foreground = [IntPtr]101
  [CuNative]::AlternateLookups = 0
  [System.Windows.Automation.AutomationElement]::FailRequestedWindow = $false
  [System.Windows.Automation.AutomationElement]::ReturnNull = $false
  [System.Windows.Automation.AutomationElement]::FailuresRemaining = 0
  [System.Windows.Automation.AutomationElement]::InvokeCount = 0
  [System.Windows.Automation.AutomationElement]::LastInvokedHwnd = 0
  [System.Windows.Automation.AutomationElement]::Lookups.Clear()
  $script:ActivationSucceeds = $true
  $script:ActivationAttempts = 0
  $script:TypedInto = 0
  $script:PointerCalls = @()
  $script:SecondaryCalls = @()
  $script:ScrollCalls = @()
  $script:DragCalls = @()
  # Reset mock switches too: leaving them set made case order decide the result,
  # so a case only passed because the previous one happened to clear the flag.
  [System.Windows.Automation.AutomationElement]::IdentityChildName = $null
  [System.Windows.Automation.AutomationElement]::DriftDecoyName = $null
  [System.Windows.Automation.AutomationElement]::HasChildren = $true
}
function Capture-Outcome([scriptblock]$work) {
  # Isolation is asserted before EVERY case, not once at load: an Add-Type added
  # later in this file would otherwise load an input assembly after the guard had
  # already passed (measured: 4 real key events while the suite was green).
  # Deliberately outside the try -- this must abort the run, not become a case's
  # error field that a test could assert around.
  $null = Assert-Isolation
  try { return @{ result = (& $work); error = $null } }
  catch { return @{ result = $null; error = $_.Exception.Message } }
}

$cases = [ordered]@{}
Reset-Fixture
[System.Windows.Automation.AutomationElement]::FailRequestedWindow = $true
$cases.binding = Capture-Outcome {
  Invoke-Action ([pscustomobject]@{ action = 'click'; app = 'fixture'; snapshot_hwnd = 101; path = '' })
}
$cases.binding.lookups = @([System.Windows.Automation.AutomationElement]::Lookups.ToArray())
$cases.binding.alternateLookups = [CuNative]::AlternateLookups
$cases.binding.invokedHwnd = [System.Windows.Automation.AutomationElement]::LastInvokedHwnd

Reset-Fixture
[System.Windows.Automation.AutomationElement]::FailuresRemaining = 2
$cases.retry = Capture-Outcome { Get-AutomationRoot ([IntPtr]101) }
$cases.retry.hwnd = $cases.retry.result.Current.NativeWindowHandle
$cases.retry.Remove('result')
$cases.retry.lookups = @([System.Windows.Automation.AutomationElement]::Lookups.ToArray())

Reset-Fixture
[System.Windows.Automation.AutomationElement]::ReturnNull = $true
$cases.nullRoot = Capture-Outcome { Get-AutomationRoot ([IntPtr]101) }

$cases.clicks = @(foreach ($click in @(
  @{ button = 'left'; count = 1 }, @{ button = 'right'; count = 1 },
  @{ button = 'middle'; count = 1 }, @{ button = 'left'; count = 2 },
  @{ button = 'left'; count = 3 }
)) {
  Reset-Fixture
  $outcome = Capture-Outcome {
    Invoke-Action ([pscustomobject]@{
      action = 'click'; app = 'fixture'; snapshot_hwnd = 101; path = ''
      mouse_button = $click.button; click_count = $click.count
    })
  }
  $outcome.button = $click.button
  $outcome.count = $click.count
  $outcome.invokeCount = [System.Windows.Automation.AutomationElement]::InvokeCount
  $outcome.pointerCalls = @($script:PointerCalls)
  $outcome
})

Reset-Fixture
[CuNative]::Foreground = [IntPtr]202
$script:ActivationSucceeds = $false
$cases.activationRejected = Capture-Outcome {
  Invoke-Action ([pscustomobject]@{ action = 'type_text'; app = 'fixture'; snapshot_hwnd = 101; text = 'sample' })
}
$cases.activationRejected.typedInto = $script:TypedInto
$cases.activationRejected.attempts = $script:ActivationAttempts

Reset-Fixture
[CuNative]::Foreground = [IntPtr]202
$cases.activationAccepted = Capture-Outcome {
  Invoke-Action ([pscustomobject]@{ action = 'type_text'; app = 'fixture'; snapshot_hwnd = 101; text = 'sample' })
}
$cases.activationAccepted.typedInto = $script:TypedInto

Reset-Fixture
[CuNative]::Foreground = [IntPtr]202
$script:ActivationSucceeds = $false
$cases.observationRejected = Capture-Outcome {
  Invoke-GetState ([pscustomobject]@{ app = 'fixture'; includeScreenshot = $false; maxDepth = 0 })
}
$cases.observeWithoutActivation = Capture-Outcome {
  Invoke-GetState ([pscustomobject]@{ app = 'fixture'; includeScreenshot = $false; maxDepth = 0; annotate = @{ activate = $false } })
}

# P3 recovery path: the snapshot's positional path no longer resolves, but the
# element identity still matches, so the action must be re-found by identity and
# report that it recovered -- never silently act on whatever now sits at the path.
# This is the case the fixture could not express before Find-ElementByIdentity
# was loadable, which is why the whole path was untested.
Reset-Fixture
[System.Windows.Automation.AutomationElement]::IdentityChildName = 'safeButton'
$cases.identityRecovery = Capture-Outcome {
  Invoke-Action ([pscustomobject]@{
    action = 'click'; app = 'fixture'; snapshot_hwnd = 101
    path = '9.9.9.9'
    element_identity = @{ name = 'safeButton'; automationId = 'safeButton'; role = 'Button' }
  })
}
$cases.identityRecovery.pointerCalls = @($script:PointerCalls)

# Identity that resolves to nothing must fail loudly instead of clicking a
# neighbour -- P3's whole reason for existing.
Reset-Fixture
[System.Windows.Automation.AutomationElement]::IdentityChildName = $null
$cases.identityMissing = Capture-Outcome {
  Invoke-Action ([pscustomobject]@{
    action = 'click'; app = 'fixture'; snapshot_hwnd = 101
    path = '9.9.9.9'
    element_identity = @{ name = 'ghost'; automationId = 'ghost'; role = 'Button' }
  })
}
$cases.identityMissing.pointerCalls = @($script:PointerCalls)

# Drift: the path STILL resolves, but onto a different element. This is the case
# P3 was written for (a re-rendered tree re-orders siblings, so the same ordinal
# lands on a neighbour) and it is a different branch from an unresolvable path
# (uia.ps1:1628 vs :1624). It reported 'identity-recovered-from-drift'.
Reset-Fixture
[System.Windows.Automation.AutomationElement]::DriftDecoyName = 'someOtherButton'
[System.Windows.Automation.AutomationElement]::IdentityChildName = 'safeButton'
$cases.identityDrift = Capture-Outcome {
  Invoke-Action ([pscustomobject]@{
    action = 'click'; app = 'fixture'; snapshot_hwnd = 101
    path = '0'
    element_identity = @{ name = 'safeButton'; automationId = 'safeButton'; role = 'Button' }
  })
}
$cases.identityDrift.pointerCalls = @($script:PointerCalls)

# Drift with nowhere to recover to: the path resolves to a neighbour and the
# recorded element is gone, so the action must fail and click nothing.
Reset-Fixture
[System.Windows.Automation.AutomationElement]::DriftDecoyName = 'someOtherButton'
[System.Windows.Automation.AutomationElement]::IdentityChildName = $null
$cases.identityDriftUnrecoverable = Capture-Outcome {
  Invoke-Action ([pscustomobject]@{
    action = 'click'; app = 'fixture'; snapshot_hwnd = 101
    path = '0'
    element_identity = @{ name = 'safeButton'; automationId = 'safeButton'; role = 'Button' }
  })
}
$cases.identityDriftUnrecoverable.pointerCalls = @($script:PointerCalls)

# The isolation guard is only worth having if a test would notice its absence.
# Report what it inspected so a case can assert on it, and assert here that a
# deliberately broken configuration is actually rejected -- a guard that cannot
# fail is a comment.
$cases.isolation = @{
  status = $script:IsolationGuard
  # How many times the guard actually executed. Capture-Outcome calls it before
  # every case, so a suite this size must show many runs; 0 or 1 means the check
  # is not wired in (or ran only at load, which an added Add-Type would outrun).
  runs = [int]$script:IsolationRuns
  caseCount = $cases.Count
  forbiddenTypes = @($script:ForbiddenTypes)
  forbiddenMembers = @($script:ForbiddenMembers)
  # Prove the detector fires: re-run the member scan against a name that is
  # definitely present, and report whether it was caught.
  detectsPresentMember = $false
}
try {
  $methods = @([CuNative].GetMethods() | ForEach-Object { $_.Name })
  $cases.isolation.detectsPresentMember = $methods -contains 'GetForegroundWindow'
} catch { }

# HasChildren=false must change the kernel's leaf-vs-truncated decision, or the
# flag is inert and the mock is still claiming "children" for every node.
Reset-Fixture
[System.Windows.Automation.AutomationElement]::HasChildren = $false
[System.Windows.Automation.AutomationElement]::IdentityChildName = 'childNode'
$cases.leafNode = Capture-Outcome {
  Invoke-GetState ([pscustomobject]@{ app = 'fixture'; includeScreenshot = $false; maxDepth = 1; annotate = @{ activate = $false } })
}
$cases.leafNode.truncatedByDepth = $cases.leafNode.result.truncatedByDepth

Reset-Fixture
[System.Windows.Automation.AutomationElement]::HasChildren = $true
[System.Windows.Automation.AutomationElement]::IdentityChildName = 'childNode'
$cases.branchNode = Capture-Outcome {
  Invoke-GetState ([pscustomobject]@{ app = 'fixture'; includeScreenshot = $false; maxDepth = 1; annotate = @{ activate = $false } })
}
$cases.branchNode.truncatedByDepth = $cases.branchNode.result.truncatedByDepth

$cases | ConvertTo-Json -Depth 12 -Compress
