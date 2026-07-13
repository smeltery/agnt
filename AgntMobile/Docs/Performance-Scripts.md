# Performance Scripts

The performance guard scripts in `AgntMobile/scripts` compare fresh XCTest metrics against a JSON baseline file. Baselines are machine- and simulator-sensitive, so supply them explicitly instead of treating one checked-in value as universal truth.

## Sidebar Run Badge

Show the required baseline shape:

```bash
AgntMobile/scripts/check-sidebar-badge-performance.sh --print-baseline-template
```

Run with an explicit baseline:

```bash
BASELINE_PATH=/path/to/Sidebar-RunBadge-Performance-Baseline.json \
  AgntMobile/scripts/check-sidebar-badge-performance.sh
```

## Turn View

Show the required baseline shape:

```bash
AgntMobile/scripts/check-turnview-performance.sh --print-baseline-template
```

Run with an explicit baseline:

```bash
BASELINE_PATH=/path/to/TurnView-Performance-Baseline.json \
  AgntMobile/scripts/check-turnview-performance.sh
```

Both scripts also accept `SCHEME`, `DESTINATION`, and `MAX_REGRESSION_PERCENT` environment overrides.

## Usage Checks

The preflight/help paths can be checked without running Xcode:

```bash
AgntMobile/scripts/test-performance-script-usage.sh
```
