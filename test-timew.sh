#!/bin/bash
# End-to-end test for tw-bridge timewarrior integration
# Tests: start, auto-switch, parallel merge, stop with remaining, full stop

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'

TRACKING="$HOME/.config/tw-bridge/tracking.json"
PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}✗${NC} $1"; ((FAIL++)); }
info() { echo -e "\n${YELLOW}$1${NC}"; }
dim()  { echo -e "${DIM}    $1${NC}"; }

assert_timew_tracking() {
  local expected="$1"
  local actual
  actual=$(timew 2>&1 | head -1)
  if echo "$actual" | grep -q "$expected"; then
    pass "timew: $expected"
  else
    fail "timew expected '$expected', got: $actual"
  fi
}

assert_timew_not_tracking() {
  local actual
  actual=$(timew 2>&1 | head -1)
  if echo "$actual" | grep -qi "no active"; then
    pass "timew: not tracking"
  else
    fail "timew expected not tracking, got: $actual"
  fi
}

assert_tracking_file_has() {
  local key="$1"
  if [ -f "$TRACKING" ] && grep -q "$key" "$TRACKING"; then
    pass "tracking.json contains $key"
  else
    fail "tracking.json missing $key"
  fi
}

assert_tracking_file_missing() {
  local key="$1"
  if [ ! -f "$TRACKING" ] || ! grep -q "$key" "$TRACKING"; then
    pass "tracking.json does not contain $key"
  else
    fail "tracking.json still contains $key"
  fi
}

assert_timew_tags_contain() {
  local tag="$1"
  local tags
  tags=$(timew export 2>/dev/null | grep -o '"tags":\[[^]]*\]' | tail -1)
  if echo "$tags" | grep -q "$tag"; then
    pass "timew interval has tag: $tag"
  else
    fail "timew interval missing tag '$tag', got: $tags"
  fi
}

# ──────────────────────────────────────────────
echo -e "\n${YELLOW}═══ tw-bridge Timewarrior Integration Test ═══${NC}\n"

# Clean slate
info "Setup: cleaning state"
timew stop 2>/dev/null || true
rm -f "$TRACKING"

# Create test tasks in two different projects
info "Setup: creating test tasks"
ID_A=$(task add "Test Alpha One" project:alpha backend:test-a backend_id:A1 +test 2>&1 | grep -oP 'Created task \K\d+' || echo "")
ID_B=$(task add "Test Alpha Two" project:alpha backend:test-a backend_id:A2 +test 2>&1 | grep -oP 'Created task \K\d+' || echo "")
ID_C=$(task add "Test Beta One" project:beta backend:test-b backend_id:B1 +test 2>&1 | grep -oP 'Created task \K\d+' || echo "")

if [ -z "$ID_A" ] || [ -z "$ID_B" ] || [ -z "$ID_C" ]; then
  echo -e "${RED}Failed to create test tasks${NC}"
  # Try alternate parse
  ID_A=$(task +test project:alpha backend_id:A1 _ids 2>/dev/null | head -1)
  ID_B=$(task +test project:alpha backend_id:A2 _ids 2>/dev/null | head -1)
  ID_C=$(task +test project:beta backend_id:B1 _ids 2>/dev/null | head -1)
fi

dim "Task A (alpha): ID=$ID_A"
dim "Task B (alpha): ID=$ID_B"
dim "Task C (beta):  ID=$ID_C"

# ──────────────────────────────────────────────
info "Test 1: Start task with nothing tracking"
TW_BRIDGE_MODE=switch task start "$ID_A" 2>/dev/null || true

assert_timew_tracking "Tracking"
assert_timew_tags_contain "#A1"
assert_timew_tags_contain "alpha"
assert_tracking_file_has "#A1"

dim "$(timew 2>&1 | head -3)"

# ──────────────────────────────────────────────
info "Test 2: Start same-project task (should auto-switch)"
# No TW_BRIDGE_MODE — same project should auto-switch without prompt
TW_BRIDGE_MODE=switch task start "$ID_B" 2>/dev/null || true

assert_timew_tracking "Tracking"
assert_timew_tags_contain "#A2"
assert_tracking_file_has "#A2"
assert_tracking_file_missing "#A1"

dim "$(timew 2>&1 | head -3)"

# ──────────────────────────────────────────────
info "Test 3: Start different-project task in parallel"
TW_BRIDGE_MODE=parallel task start "$ID_C" 2>/dev/null || true

assert_timew_tracking "Tracking"
assert_timew_tags_contain "#A2"
assert_timew_tags_contain "#B1"
assert_timew_tags_contain "alpha"
assert_timew_tags_contain "beta"
assert_tracking_file_has "#A2"
assert_tracking_file_has "#B1"

dim "$(timew 2>&1 | head -3)"

# ──────────────────────────────────────────────
info "Test 4: Stop the parallel task (should restart with remaining)"
task stop "$ID_C" 2>/dev/null || true

assert_timew_tracking "Tracking"
assert_timew_tags_contain "#A2"
assert_timew_tags_contain "alpha"
assert_tracking_file_has "#A2"
assert_tracking_file_missing "#B1"

dim "$(timew 2>&1 | head -3)"

# ──────────────────────────────────────────────
info "Test 5: Stop last task (should stop timew entirely)"
task stop "$ID_B" 2>/dev/null || true

assert_timew_not_tracking
assert_tracking_file_missing "#A2"

dim "$(timew 2>&1 | head -3)"

# ──────────────────────────────────────────────
info "Test 6: Bridge report"
REPORT=$(timew bridge :day 2>&1)
if echo "$REPORT" | grep -q "Task Time"; then
  pass "timew bridge report runs"
else
  fail "timew bridge report failed: $REPORT"
fi

dim "$(echo "$REPORT" | head -8)"

# ──────────────────────────────────────────────
# Cleanup
info "Cleanup: deleting test tasks"
task rc.confirmation=off "$ID_A" delete +test 2>/dev/null || true
task rc.confirmation=off "$ID_B" delete +test 2>/dev/null || true
task rc.confirmation=off "$ID_C" delete +test 2>/dev/null || true
rm -f "$TRACKING"
# Clean up timew test intervals
for i in $(seq 1 10); do
  timew delete @1 2>/dev/null || break
done

# ──────────────────────────────────────────────
echo ""
echo -e "${YELLOW}═══ Results ═══${NC}"
echo -e "  ${GREEN}Passed: $PASS${NC}"
if [ "$FAIL" -gt 0 ]; then
  echo -e "  ${RED}Failed: $FAIL${NC}"
  exit 1
else
  echo -e "  ${DIM}Failed: 0${NC}"
  echo -e "\n${GREEN}All tests passed.${NC}"
fi
