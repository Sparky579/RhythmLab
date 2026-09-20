#!/usr/bin/env bash
# 指针小圆点正常但 App 收不到 —— 事件卡在安卓的派发环节。
# 这里不需要 root：查谁注册了手势拦截/无障碍，再在断流当场抓 InputDispatcher 的日志。
set -euo pipefail
SECS="${1:-40}"
OUT=/tmp/touchdiag
mkdir -p "$OUT"

adb wait-for-device
echo "设备：$(adb shell getprop ro.product.model | tr -d '\r') / Android $(adb shell getprop ro.build.version.release | tr -d '\r')"
echo

echo "===== 1. 正在运行的无障碍服务（最常见的多指拦截来源）====="
adb shell settings get secure enabled_accessibility_services | tr -d '\r'
adb shell settings get secure accessibility_enabled | tr -d '\r' | sed 's/^/accessibility_enabled=/'
adb shell dumpsys accessibility 2>/dev/null \
  | grep -iE "Service\[|mRequestMultiFingerGestures|mRequestTouchExplorationMode|touchExplorationEnabled" \
  | head -20
echo

echo "===== 2. 注册在输入系统上的手势监听器 ====="
adb shell dumpsys input 2>/dev/null \
  | grep -iE "GestureMonitor|Monitors|inputChannel.*monitor|isGestureMonitor" | head -20
echo

echo "===== 3. 省电/后台管控对前台应用的限制 ====="
for pkg in ren.pekka.rhythmlab com.android.chrome; do
  echo "-- $pkg"
  adb shell dumpsys deviceidle whitelist 2>/dev/null | grep -i "$pkg" || echo "   不在电池白名单"
done
echo

echo "===== 4. 现在开始抓 ${SECS} 秒日志：请四指狂点，断流时不要停 ====="
adb logcat -c 2>/dev/null || true
timeout "$SECS" adb logcat -v time \
  InputDispatcher:V InputReader:V ANRManager:V WindowManager:W \
  TouchExplorer:V AccessibilityInputFilter:V '*:S' > "$OUT/logcat.txt" 2>/dev/null || true
echo "抓完，共 $(wc -l < "$OUT/logcat.txt") 行"
echo

echo "===== 5. 结论 ====="
if grep -qiE "has not finished processing|not responded|Waiting to send" "$OUT/logcat.txt"; then
  echo ">>> InputDispatcher 在等 App 处理完上一批事件，期间新事件被扣住："
  grep -iE "has not finished processing|not responded|Waiting to send" "$OUT/logcat.txt" | head -10
  echo "    这是 WebView 回执太慢导致的派发阻塞，属于应用侧，我能继续改。"
elif grep -qiE "TouchExplorer|AccessibilityInputFilter|MultiFinger" "$OUT/logcat.txt"; then
  echo ">>> 无障碍的触摸探索/多指手势在拦截："
  grep -iE "TouchExplorer|AccessibilityInputFilter|MultiFinger" "$OUT/logcat.txt" | head -10
  echo "    关掉第 1 节列出的那些无障碍服务即可。"
elif grep -qiE "Dropped|rejecting|intercept|palm|suppress" "$OUT/logcat.txt"; then
  echo ">>> 有事件被系统丢弃/拦截："
  grep -iE "Dropped|rejecting|intercept|palm|suppress" "$OUT/logcat.txt" | head -10
else
  echo ">>> 日志里没有拦截痕迹，多半是 ROM 私有的防误触逻辑（不打标准日志）。"
  echo "    完整日志：$OUT/logcat.txt"
fi
