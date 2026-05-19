/**
 * Screen Reader Module - Reads text from active window using Windows UI Automation
 * Runs entirely in main process. Falls back to error if UI Automation unavailable.
 */
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PS_SCRIPT_PATH = path.join(os.tmpdir(), 'interview-assistant-uia.ps1');

// Write the PowerShell script to a temp file (once)
const PS_SCRIPT = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

try {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

  # Walk up to find the top-level window
  $window = $focused
  $attempts = 0
  while ($window -ne $null -and $window -ne $root -and $attempts -lt 20) {
    $parent = $walker.GetParent($window)
    if ($parent -eq $null -or $parent -eq $root) { break }
    $window = $parent
    $attempts++
  }

  if ($window -eq $null -or $window -eq $root) {
    Write-Output "ERROR:Could not find active window"
    exit
  }

  $title = $window.Current.Name
  Write-Output "TITLE:$title"

  # Collect all text from the window
  $allText = New-Object System.Text.StringBuilder
  $condition = [System.Windows.Automation.Condition]::TrueCondition
  $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)

  foreach ($el in $elements) {
    try {
      $name = $el.Current.Name
      if ($name -and $name.Length -gt 1 -and $name.Length -lt 5000) {
        [void]$allText.AppendLine($name)
      }
    } catch {}
    try {
      $valPattern = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valPattern)) {
        $val = $valPattern.Current.Value
        if ($val -and $val.Length -gt 1 -and $val.Length -lt 5000) {
          [void]$allText.AppendLine($val)
        }
      }
    } catch {}
    try {
      $txtPattern = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$txtPattern)) {
        $range = $txtPattern.DocumentRange
        $txt = $range.GetText(10000)
        if ($txt -and $txt.Length -gt 1) {
          [void]$allText.AppendLine($txt)
        }
      }
    } catch {}
  }

  Write-Output "TEXT_START"
  Write-Output $allText.ToString()
  Write-Output "TEXT_END"
} catch {
  Write-Output "ERROR:$($_.Exception.Message)"
}
`;

// Ensure script file exists
function ensureScript() {
  try {
    fs.writeFileSync(PS_SCRIPT_PATH, PS_SCRIPT, 'utf8');
  } catch(e) {
    console.error('Failed to write PS script:', e);
  }
}

ensureScript();

function readActiveWindowText() {
  return new Promise((resolve) => {
    const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${PS_SCRIPT_PATH}"`;

    exec(cmd, { timeout: 8000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ error: 'UI Automation failed: ' + error.message, title: '', text: '' });
        return;
      }

      const output = stdout.toString();

      if (output.includes('ERROR:')) {
        const errMsg = output.split('ERROR:')[1].split('\n')[0].trim();
        resolve({ error: errMsg, title: '', text: '' });
        return;
      }

      let title = '';
      let text = '';

      const titleMatch = output.match(/TITLE:(.*)/);
      if (titleMatch) title = titleMatch[1].trim();

      const textMatch = output.match(/TEXT_START\s*([\s\S]*?)\s*TEXT_END/);
      if (textMatch) text = textMatch[1].trim();

      // Deduplicate lines (UI Automation often returns duplicates)
      const lines = text.split('\n');
      const seen = new Set();
      const unique = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !seen.has(trimmed)) {
          seen.add(trimmed);
          unique.push(trimmed);
        }
      }
      text = unique.join('\n');

      resolve({ error: null, title, text });
    });
  });
}

module.exports = { readActiveWindowText };
