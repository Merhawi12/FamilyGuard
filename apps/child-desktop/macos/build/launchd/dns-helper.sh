#!/bin/sh
#
# Parentix — the privileged half of website filtering on macOS.
#
# launchd runs this as root whenever /Users/Shared/Parentix/dns-request.json
# changes (see ca.parentix.child-desktop.helper.plist). It is the only part of
# Parentix on this machine that runs with any privilege at all, which is why it
# is fourteen lines of shell rather than something larger: everything here can be
# read in one sitting by whoever has to trust it.
#
# It accepts exactly two instructions and **no addresses**. /Users/Shared is
# writable by every local account, so anything this script accepts, any user of
# the Mac can ask for as root. A request carrying a list of DNS servers would
# therefore be a local privilege escalation shipped inside a parental control.
# Instead this script decides what "redirect" means — always the loopback — and
# keeps its own snapshot of what was there before, in a root-owned file the
# requesting user cannot edit.
#
#   {"id":"…","action":"redirect","ipv6":true}   point every service at 127.0.0.1
#   {"id":"…","action":"restore"}                put every service back
#
# The answer goes to dns-result.json with the same id, so the agent knows its own
# request was the one that was served.

set -u

SHARED=/Users/Shared/Parentix
REQUEST="$SHARED/dns-request.json"
RESULT="$SHARED/dns-result.json"
SNAPSHOT="$SHARED/dns-snapshot.tsv"
NETWORKSETUP=/usr/sbin/networksetup

# The request is written by us and is a single flat object; three `sed`
# extractions are the whole parser it needs.
id=""
action=""
ipv6="false"
if [ -f "$REQUEST" ]; then
  id=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$REQUEST")
  action=$(sed -n 's/.*"action":"\([^"]*\)".*/\1/p' "$REQUEST")
  ipv6=$(sed -n 's/.*"ipv6":\([a-z]*\).*/\1/p' "$REQUEST")
fi

# ── The boot run ─────────────────────────────────────────────────────────────
#
# launchd also starts this once at load (`RunAtLoad`), before anyone has signed
# in and therefore before the agent exists. A stale request file is not an
# instruction at that point — re-applying yesterday's `redirect` at boot is
# exactly backwards — so anything older than two minutes is treated as a boot
# run instead.
#
# And a boot run has something useful to do. A snapshot existing at boot can
# only mean the Mac was shut down while its resolver pointed at 127.0.0.1, which
# is a machine that comes up with no working DNS at all and a child who cannot
# load a page to find out why. Restoring is the macOS half of what
# `repairSystemDns` does inside the agent; the agent redirects again after login.
now=$(date +%s)
mtime=$(stat -f %m "$REQUEST" 2>/dev/null || echo 0)
if [ -z "$action" ] || [ $((now - mtime)) -gt 120 ]; then
  [ -s "$SNAPSHOT" ] || exit 0
  id="boot"
  action="restore"
fi

answer() {
  printf '{"id":"%s","ok":%s,"action":"%s"}\n' "$id" "$1" "$action" > "$RESULT"
  chmod 644 "$RESULT" 2>/dev/null
  exit 0
}

# The header line, and any service the user has disabled.
services() {
  "$NETWORKSETUP" -listallnetworkservices 2>/dev/null | sed -e '1d' -e '/^\*/d'
}

flush() {
  /usr/bin/dscacheutil -flushcache 2>/dev/null
  # Both, and in this order: emptying the directory-services cache without
  # restarting the resolver that answers is why a DNS change on a Mac often
  # "does not take".
  /usr/bin/killall -HUP mDNSResponder 2>/dev/null
}

case "$action" in
  redirect)
    # An existing snapshot is never overwritten. Applying twice would otherwise
    # record 127.0.0.1 as what the machine "used to be set to", and the restore
    # would put it back where it started with nothing left to recover.
    if [ ! -s "$SNAPSHOT" ]; then
      tmp="$SNAPSHOT.$$"
      : > "$tmp"
      services | while IFS= read -r service; do
        current=$("$NETWORKSETUP" -getdnsservers "$service" 2>/dev/null \
          | grep -E '^[0-9a-fA-F.:]+$' \
          | grep -v -x -e '127.0.0.1' -e '::1' \
          | tr '\n' ' ')
        [ -z "$current" ] && current="Empty"
        printf '%s\t%s\n' "$service" "$current" >> "$tmp"
      done
      mv "$tmp" "$SNAPSHOT"
      # Root-owned and root-writable: the snapshot is the only thing standing
      # between a redirected Mac and a permanent one.
      chown root:wheel "$SNAPSHOT" 2>/dev/null
      chmod 600 "$SNAPSHOT" 2>/dev/null
    fi

    if [ "$ipv6" = "true" ]; then addresses="127.0.0.1 ::1"; else addresses="127.0.0.1"; fi
    services | while IFS= read -r service; do
      # shellcheck disable=SC2086 — the word split is the point; these are two
      # separate arguments to networksetup, and both are literals from above.
      "$NETWORKSETUP" -setdnsservers "$service" $addresses 2>/dev/null
    done
    flush
    answer true
    ;;

  restore)
    [ -s "$SNAPSHOT" ] || answer false
    while IFS="$(printf '\t')" read -r service servers; do
      [ -n "$service" ] || continue
      [ "$servers" = "Empty" ] && servers=""
      if [ -z "$servers" ]; then
        "$NETWORKSETUP" -setdnsservers "$service" Empty 2>/dev/null
      else
        # shellcheck disable=SC2086 — see above; these came from our own snapshot.
        "$NETWORKSETUP" -setdnsservers "$service" $servers 2>/dev/null
      fi
    done < "$SNAPSHOT"
    rm -f "$SNAPSHOT"
    flush
    answer true
    ;;

  *)
    answer false
    ;;
esac
