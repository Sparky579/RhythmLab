#!/usr/bin/env bash
# 抓触摸屏的内核级原始报点，找出 >500ms 的空档。
# 这一层在安卓框架之下：这里要是也断，就跟任何 App、任何浏览器都无关了。
set -euo pipefail
SECS="${1:-40}"

adb wait-for-device
echo "设备：$(adb shell getprop ro.product.model | tr -d '\r') / Android $(adb shell getprop ro.build.version.release | tr -d '\r')"

# 找触摸屏：优先带 ABS_MT_POSITION 能力的节点
DEV="$(adb shell su -c 'getevent -pl' 2>/dev/null | awk '
  /^add device/ { dev = $NF }
  /ABS_MT_POSITION_X/ { print dev; exit }')"
if [ -z "${DEV:-}" ]; then
  DEV="$(adb shell getevent -pl 2>/dev/null | awk '
    /^add device/ { dev = $NF }
    /ABS_MT_POSITION_X/ { print dev; exit }')"
fi
[ -n "${DEV:-}" ] || { echo "没找到触摸屏节点（可能需要 root）"; exit 1; }
DEV="$(echo "$DEV" | tr -d '\r')"
echo "触摸屏节点：$DEV"
echo "开始抓 ${SECS} 秒 —— 现在用四指在屏幕上连续狂点，直到提示结束"

adb shell "timeout ${SECS} getevent -lt $DEV" > /tmp/touchtrace.raw 2>/dev/null || true
echo "抓完，共 $(wc -l < /tmp/touchtrace.raw) 行"

python3 - <<'PY'
import re
rows = []
for line in open('/tmp/touchtrace.raw', errors='ignore'):
    m = re.match(r'\s*\[\s*([0-9.]+)\s*\]', line)
    if m:
        rows.append(float(m.group(1)))
if len(rows) < 2:
    print('没抓到报点，可能需要 root 或换节点')
    raise SystemExit
gaps = []
for a, b in zip(rows, rows[1:]):
    if b - a > 0.5:
        gaps.append((a, (b - a) * 1000))
span = rows[-1] - rows[0]
print(f'时长 {span:.1f}s，报点 {len(rows)} 条，平均 {len(rows)/span:.0f}/秒')
if gaps:
    print(f'内核级空档 {len(gaps)} 段，最长 {max(g[1] for g in gaps):.0f}ms：')
    for t, ms in gaps[:20]:
        print(f'  第 {t-rows[0]:6.1f}s 处，断 {ms:.0f}ms')
    print('\n>>> 内核这一层就断了：驱动/触控固件/硬件，App 与浏览器都无能为力。')
else:
    print('\n>>> 内核一直在报点，没有断档。'
          '\n    那么丢在安卓框架分发给 App 的环节，属于系统策略问题，关掉相关手势/省电限制有救。')
PY
