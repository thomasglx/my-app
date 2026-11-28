#!/bin/bash
# MyApp Mac sync — installer. Run in Terminal:
#   bash <(curl -fsSL https://thomasglx.github.io/my-app/mac/install.sh)
# Uninstall:  bash <(curl -fsSL https://thomasglx.github.io/my-app/mac/install.sh) uninstall
set -e
DIR="$HOME/Library/Application Support/MyAppSync"
PLIST="$HOME/Library/LaunchAgents/com.myapp.sync.plist"
LABEL="com.myapp.sync"
URL="https://thomasglx.github.io/my-app/mac/myapp_sync.py"

if [ "$1" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ MyApp sync stopped and removed (your files in $DIR were kept)."
  exit 0
fi

echo "== MyApp Mac sync =="
echo
echo "1/5  Checking Python…"
if ! /usr/bin/python3 -c "import sqlite3, imaplib" 2>/dev/null; then
  echo "   Python is not installed yet. A window will open: click Install, wait, then run this command again."
  xcode-select --install 2>/dev/null || true
  exit 1
fi
REAL_PY=$(/usr/bin/python3 -c "import sys; print(sys.executable)")
# The binary that really runs (and needs Full Disk Access) is Python.app inside the framework
PY_BIN=$(ls -d /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/Current/Resources/Python.app/Contents/MacOS/Python 2>/dev/null || echo /usr/bin/python3)
echo "   ✓ $REAL_PY"

echo "2/5  Downloading the program…"
mkdir -p "$DIR"
curl -fsSL "$URL?$(date +%s)" -o "$DIR/myapp_sync.py"
echo "   ✓ $DIR/myapp_sync.py"

echo "3/5  Secrets (stored in your Mac's Keychain, never in a file)"
save() { security add-generic-password -U -a myapp -s "$1" -T /usr/bin/security -w "$2" >/dev/null; }
if security find-generic-password -s myapp-github -w >/dev/null 2>&1; then
  read -r -p "   A GitHub key is already saved. Replace it? (y/N) " R; [ "$R" = "y" ] && NEED_GH=1
else NEED_GH=1; fi
if [ -n "$NEED_GH" ]; then read -r -s -p "   Paste the GitHub key for the Mac (github_pat_…): " T; echo; T=$(printf %s "$T" | tr -cd 'A-Za-z0-9_'); save myapp-github "$T"; echo "   key starts with: ${T:0:11}"; fi
if security find-generic-password -s myapp-gmail -w >/dev/null 2>&1; then
  read -r -p "   A Gmail app password is already saved. Replace it? (y/N) " R; [ "$R" = "y" ] && NEED_GM=1
else NEED_GM=1; fi
if [ -n "$NEED_GM" ]; then
  read -r -p "   Your Gmail address: " U; save myapp-gmail-user "$(printf %s "$U" | tr -d '[:space:][:cntrl:]')"
  read -r -s -p "   Paste the Gmail app password (16 letters, spaces don't matter): " P; echo; save myapp-gmail "$(printf %s "$P" | tr -cd 'A-Za-z')"
fi
echo "   ✓ saved"

echo "4/5  Full Disk Access (needed to read Messages, WhatsApp and calls)"
echo "   System Settings will open on Privacy & Security → Full Disk Access, and a Finder window will show Python."
echo "   Drag the selected Python from Finder into the list, and switch it ON."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" || true
APP=$(echo "$REAL_PY" | sed -n 's#\(.*/Python\.app\)/.*#\1#p')
open -R "${APP:-$REAL_PY}" || true
read -r -p "   Press Enter once Python is ON in the list… " _

echo "5/5  Starting the automatic sync (every 2 minutes)…"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY_BIN</string><string>$DIR/myapp_sync.py</string></array>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/sync.log</string>
  <key>StandardErrorPath</key><string>$DIR/sync.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
echo "   First run (it reads the last 30 days, can take up to a minute)…"
for i in $(seq 1 30); do sleep 3; grep -q "sources" "$DIR/sync.log" 2>/dev/null && break; done
echo
grep -E "sources|FAILED|failed" "$DIR/sync.log" | tail -3 || true
echo
echo "✓ Installed. Every source should say 'ok'. If one says 'error', send a screenshot of this window to Claude."
echo "  Then check MyApp → Networking → Today: 'Mac synced … ago'."
