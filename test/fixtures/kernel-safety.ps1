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
      if ((scope & (TreeScope.Children | TreeScope.Descendants | TreeScope.Subtree)) == 0)
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
      if ((scope & (TreeScope.Children | TreeScope.Descendants | TreeScope.Subtree)) == 0)
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
# The kernel sends real input through [CuInput] and [System.Windows.Forms
# .SendKeys], and screenshots through [System.Drawing]. None of those exist here
# because extraction runs only FUNCTION BODIES: the top-level Add-Type lines that
# define them never execute.
#
# That is an accident of this design, not a decision -- and a dangerous one. Add
# one `Add-Type -AssemblyName System.Windows.Forms` here (say, to make set_value
# testable) and the loaded Invoke-Action would start typing into real windows
# while the suite still reported green. Fail loudly instead.
#
# CuNative is deliberately NOT on this list: this fixture defines its own
# CuNative mock (queries only). The real one in lib/uia.ps1 additionally carries
# keybd_event. Capability is checked below instead of trusting the name.
$forbidden = @(
  'CuInput',                       # SendMouse / SendKey / SendUnicode
  'System.Windows.Forms.SendKeys', # SendWait
  'System.Drawing.Bitmap'          # CopyFromScreen target
)
foreach ($name in $forbidden) {
  $available = $false
  try { $null = [type]$name; $available = $true } catch { }
  if ($available) {
    throw ("fixture isolation broken: [$name] is available in this process, so the loaded kernel " +
      'could send real input or capture the real screen. Do not load those assemblies here; stub the ' +
      'helper instead (see Invoke-ClickAt / Invoke-Scroll).')
  }
}
# The mock CuNative must stay query-only. If it ever grows an input method, the
# loaded kernel could call it and really press keys.
foreach ($member in @('keybd_event', 'SendKey', 'SendUnicode', 'SendMouse')) {
  $has = $false
  try { $has = $null -ne ([CuNative].GetMethod($member)) } catch { }
  if ($has) {
    throw "fixture isolation broken: the mock [CuNative] exposes '$member'; it must stay query-only."
  }
}
$script:IsolationGuard = 'ok'

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

$cases | ConvertTo-Json -Depth 12 -Compress
