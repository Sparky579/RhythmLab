package ren.pekka.rhythmlab;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

/**
 * RhythmLab 安卓壳。
 *
 * 它只解决网页端解决不了的这几件事：
 *   1. setSystemGestureExclusionRects —— 把屏幕左右边缘从系统手势里划出来，
 *      安卓手势导航不再抢走最外侧轨道的触摸（网页端只能靠留白躲开）。
 *   2. 原生 MotionEvent 直采 —— 在 Activity 层拿到每一个 ACTION_DOWN /
 *      ACTION_POINTER_DOWN，用 event.getEventTime() 的真实时刻转发给 JS，
 *      不经过 WebView 的 DOM 事件管线。
 *   3. 常亮 + 沉浸式全屏 —— 没有地址栏伸缩、没有下拉刷新。
 *   4. onShowFileChooser —— WebView 默认根本不处理 <input type="file">，
 *      点了没有任何反应（连报错都没有）。上传自己的音乐必须靠它。
 *
 * 原生事件不消费（dispatchTouchEvent 照常下发），所以 DOM 事件仍然存在，
 * JS 端一旦发现原生事件没来会自动退回 DOM 模式，不至于整个玩不了。
 */
public class MainActivity extends Activity {

    private WebView web;
    /** 页面资源走这个假域名，由 shouldInterceptRequest 从 assets 里喂，
     *  这样 origin 是正常的 https，fetch 音频不会被 file:// 的同源策略挡住。 */
    private static final String ORIGIN = "https://rhythmlab.local/";
    private static final float MOVE_EPS_DP = 6f;
    private static final int REQ_FILE = 1001;

    /** 正在等结果的 <input type="file">。必须保证每一条路径都回调一次，
     *  哪怕用户按了返回 —— 不回调的话这个 input 之后再点就永远没反应了。 */
    private ValueCallback<Uri[]> filePicker;

    private float density = 2f;
    private boolean exclusionOk = false;
    private String exclusionNote = "-";
    private final SparseFloats lastSentX = new SparseFloats();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        density = getResources().getDisplayMetrics().density;

        web = new WebView(this);
        WebSettings st = web.getSettings();
        st.setJavaScriptEnabled(true);
        st.setDomStorageEnabled(true);
        st.setMediaPlaybackRequiresUserGesture(false);
        // UA 打个标记：页面据此知道自己跑在原生壳里，桥没注入上时也能把问题显出来
        web.addJavascriptInterface(new Shell(), "RLShell");
        st.setUserAgentString(st.getUserAgentString() + " RhythmLabShell/4");
        st.setSupportZoom(false);
        st.setBuiltInZoomControls(false);
        st.setCacheMode(WebSettings.LOAD_NO_CACHE);
        st.setAllowFileAccess(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);
        WebView.setWebContentsDebuggingEnabled(true);

        /* WebView 不自带文件选择：不实现这个回调，页面里的 <input type="file">
           点下去什么都不会发生。上传音乐就是这么「没反应」的。 */
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (filePicker != null) filePicker.onReceiveValue(null);
                filePicker = cb;
                Intent pick = null;
                try { pick = params.createIntent(); } catch (Throwable ignored) { }
                if (pick == null) {
                    pick = new Intent(Intent.ACTION_GET_CONTENT);
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    pick.setType("audio/*");
                }
                try {
                    startActivityForResult(Intent.createChooser(pick, "选择音乐"), REQ_FILE);
                    return true;
                } catch (Throwable t) {
                    // 装不出选择器：交回 null 让 WebView 自己收场，别把 input 卡死
                    filePicker = null;
                    return false;
                }
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (!url.startsWith(ORIGIN)) return null;
                String path = url.substring(ORIGIN.length());
                int q = path.indexOf('?');
                if (q >= 0) path = path.substring(0, q);
                if (path.isEmpty()) path = "index.html";
                try {
                    InputStream in = getAssets().open("www/" + path);
                    return new WebResourceResponse(mimeOf(path), "utf-8", in);
                } catch (IOException e) {
                    return null;
                }
            }
            @Override
            public void onPageFinished(WebView v, String url) {
                // 告诉页面：现在跑在原生壳里，可以接收原生触摸
                v.evaluateJavascript("window.__RHYTHMLAB_NATIVE__=1;"
                        + "window.dispatchEvent(new Event('rhythmlab-native'));", null);
                applyImmersive();
                applyGestureExclusion();
            }
        });

        setContentView(web);
        web.loadUrl(ORIGIN + "index.html");

        View decor = getWindow().getDecorView();
        decor.setOnSystemUiVisibilityChangeListener(new View.OnSystemUiVisibilityChangeListener() {
            @Override public void onSystemUiVisibilityChange(int visibility) {
                // 沉浸式下边缘触摸会让系统栏临时探头，这一下就会取消整串触摸。
                // 数一下它发生了多少次，好和 touchcancel 对上。
                sysUiChanges++;
                lastSysUiAt = SystemClock.uptimeMillis();
                applyImmersive();
            }
        });
        decor.addOnLayoutChangeListener(new View.OnLayoutChangeListener() {
            @Override public void onLayoutChange(View v, int l, int t, int r, int b,
                                                 int ol, int ot, int or_, int ob) {
                applyGestureExclusion();
            }
        });
    }

    private static String mimeOf(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "application/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".ogg")) return "audio/ogg";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    private void applyImmersive() {
        // API 30+ 用新的 WindowInsetsController：系统栏只在滑动时临时出现，
        // 松手立刻缩回去，减少误触到通知栏 / 导航栏的机会。反射调用是因为这里编译到 API 23。
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                Object c = getWindow().getClass()
                        .getMethod("getInsetsController").invoke(getWindow());
                if (c != null) {
                    Class<?> t = Class.forName("android.view.WindowInsets$Type");
                    int bars = (Integer) t.getMethod("systemBars").invoke(null);
                    c.getClass().getMethod("hide", int.class).invoke(c, bars);
                    c.getClass().getMethod("setSystemBarsBehavior", int.class)
                            .invoke(c, 2 /* BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE */);
                }
                getWindow().getClass().getMethod("setDecorFitsSystemWindows", boolean.class)
                        .invoke(getWindow(), Boolean.FALSE);
            } catch (Throwable ignored) {
                // 拿不到就退回老的 SYSTEM_UI_FLAG 那套
            }
        }
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    /**
     * 把左右边缘整条划归应用，安卓 10+ 的返回手势不再从这里抢触摸。
     * 用反射调用是因为这里只编译到 API 23；低版本自然没有这个问题。
     */
    private void applyGestureExclusion() {
        if (Build.VERSION.SDK_INT < 29 || web == null) return;
        try {
            int w = web.getWidth(), h = web.getHeight();
            if (w <= 0 || h <= 0) return;
            // 排除区的「沿边长度」每条边最多 200dp，超了系统只保留靠下的那 200dp。
            // 与其让它自己截，不如直接指定靠下的 200dp —— 手指本来就落在判定线附近。
            // 宽度方向不受这个上限约束，所以放宽到 110dp，把返回手势区整个盖住。
            int band = Math.round(110 * density);
            int reach = Math.round(200 * density);
            int top = Math.max(0, h - reach);
            List<Rect> rects = new ArrayList<Rect>();
            rects.add(new Rect(0, top, Math.min(band, w), h));
            rects.add(new Rect(Math.max(0, w - band), top, w, h));
            Method m = View.class.getMethod("setSystemGestureExclusionRects", List.class);
            m.invoke(web, rects);
            exclusionOk = true;
            exclusionNote = band + "x" + (h - top) + "px";
        } catch (Throwable t) {
            exclusionOk = false;
            exclusionNote = t.getClass().getSimpleName();
        }
        reportShellState();
    }

    /** 原生层收到的动作计数。页面看到的 touchcancel 如果在这里没有对应的
     *  ACTION_CANCEL，说明取消是 WebView 自己造出来的，不是安卓发的。 */
    private int nDown, nMove, nUp, nCancel, nMaxPointers, nCancelNearSysUi;
    private long lastNativeAt, maxNativeGap;

    private void countNative(int action, MotionEvent ev) {
        long now = SystemClock.uptimeMillis();
        if (lastNativeAt != 0 && now - lastNativeAt > maxNativeGap) maxNativeGap = now - lastNativeAt;
        lastNativeAt = now;
        if (ev.getPointerCount() > nMaxPointers) nMaxPointers = ev.getPointerCount();
        switch (action) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_POINTER_DOWN: nDown++; break;
            case MotionEvent.ACTION_MOVE: nMove++; break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_POINTER_UP: nUp++; break;
            case MotionEvent.ACTION_CANCEL:
                nCancel++;
                // 取消发生时，距上一次系统栏可见性变化多久：贴得越近越说明是它
                if (lastSysUiAt != 0) {
                    long d = now - lastSysUiAt;
                    if (d < 300) nCancelNearSysUi++;
                }
                break;
            default: break;
        }
    }

    /** 只读的测量接口：页面在生成诊断时取一次，没有逐事件开销。 */
    public final class Shell {
        @android.webkit.JavascriptInterface
        public String stats() {
            return "{\"down\":" + nDown + ",\"move\":" + nMove + ",\"up\":" + nUp
                    + ",\"cancel\":" + nCancel + ",\"maxPointers\":" + nMaxPointers
                    + ",\"maxGap\":" + maxNativeGap
                    + ",\"sysUi\":" + sysUiChanges
                    + ",\"cancelNearSysUi\":" + nCancelNearSysUi
                    + ",\"evalCalls\":" + evalCalls
                    + ",\"maxDispatchUs\":" + maxDispatchUs
                    + ",\"avgDispatchUs\":" + (dispatchCount > 0 ? dispatchTotalUs / dispatchCount : 0)
                    + "}";
        }
        @android.webkit.JavascriptInterface
        public void reset() {
            nDown = nMove = nUp = nCancel = nMaxPointers = nCancelNearSysUi = 0;
            sysUiChanges = 0; lastSysUiAt = 0;
            maxNativeGap = 0; lastNativeAt = 0;
            evalCalls = 0; maxDispatchUs = 0; dispatchTotalUs = 0; dispatchCount = 0;
        }
    }

    /** 系统自己声明的手势区有多宽（API 29+）。排除区没盖住它就会被接管。 */
    private int[] gestureInsets() {
        try {
            Object insets = web.getClass().getMethod("getRootWindowInsets").invoke(web);
            Object gi = insets.getClass().getMethod("getSystemGestureInsets").invoke(insets);
            int l = gi.getClass().getField("left").getInt(gi);
            int r = gi.getClass().getField("right").getInt(gi);
            int b = gi.getClass().getField("bottom").getInt(gi);
            return new int[] { l, r, b };
        } catch (Throwable t) {
            return new int[] { -1, -1, -1 };
        }
    }

    /** 把外壳自己的状态喂给页面，好让诊断里能看见排除区到底有没有生效。 */
    private void reportShellState() {
        if (web == null) return;
        int[] g = gestureInsets();
        final String js = "window.__shell=" + "{ok:" + exclusionOk
                + ",band:'" + exclusionNote + "'"
                + ",dpr:" + density
                + ",gl:" + g[0] + ",gr:" + g[1] + ",gb:" + g[2] + "};";
        web.post(new Runnable() { public void run() {
            try { web.evaluateJavascript(js, null); } catch (Throwable ignored) { }
        } });
    }

    /** 原生触摸直采：不消费，只是抢先把每一个按下/抬起/移动转发给 JS。 */
    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        final long t0 = System.nanoTime();
        try { forward(ev); } catch (Throwable ignored) { }
        boolean r = super.dispatchTouchEvent(ev);
        // 派发这一步花了多久：慢的就是它拖住了 finishInputEvent
        long us = (System.nanoTime() - t0) / 1000;
        dispatchTotalUs += us;
        if (us > maxDispatchUs) maxDispatchUs = us;
        dispatchCount++;
        return r;
    }

    private long maxDispatchUs, dispatchTotalUs;
    private int dispatchCount;
    private int sysUiChanges;
    private long lastSysUiAt;

    private void forward(MotionEvent ev) {
        if (web == null) return;
        final int action = ev.getActionMasked();
        countNative(action, ev);
        // 事件已经排队了多久：JS 端用 performance.now() - age 还原真实时刻
        final float age = SystemClock.uptimeMillis() - ev.getEventTime();

        switch (action) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_POINTER_DOWN: {
                int i = ev.getActionIndex();
                send("d", ev.getPointerId(i), ev.getX(i), ev.getY(i), age);
                lastSentX.put(ev.getPointerId(i), ev.getX(i));
                break;
            }
            case MotionEvent.ACTION_MOVE: {
                float eps = MOVE_EPS_DP * density;
                for (int i = 0; i < ev.getPointerCount(); i++) {
                    int id = ev.getPointerId(i);
                    float x = ev.getX(i);
                    if (Math.abs(x - lastSentX.get(id)) < eps) continue;
                    lastSentX.put(id, x);
                    send("m", id, x, ev.getY(i), age);
                }
                break;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_POINTER_UP:
            case MotionEvent.ACTION_CANCEL: {
                int i = ev.getActionIndex();
                send("u", ev.getPointerId(i), ev.getX(i), ev.getY(i), age);
                lastSentX.remove(ev.getPointerId(i));
                break;
            }
            default:
                break;
        }
    }

    /* 攒批下发。
       原先每个触摸动作都同步调一次 evaluateJavascript，高频时每秒几百次跨进程调用，
       会把 dispatchTouchEvent 的返回拖慢；返回慢就是 finishInputEvent 慢，
       InputDispatcher 判定窗口跟不上，于是发 ACTION_CANCEL 并停止派发 ——
       这正是「只有高频才断」的样子。改成在 UI 线程的下一个消息里一次性发完。 */
    private final StringBuilder batch = new StringBuilder(512);
    private int batchCount;
    private boolean flushScheduled;
    private int evalCalls;

    private final Runnable flush = new Runnable() {
        public void run() {
            flushScheduled = false;
            if (batchCount == 0 || web == null) return;
            final String js = "window.MG&&MG.nativeBatch&&MG.nativeBatch(\"" + batch + "\")";
            batch.setLength(0);
            batchCount = 0;
            evalCalls++;
            try { web.evaluateJavascript(js, null); } catch (Throwable ignored) { }
        }
    };

    /* 一条记录是 "类型,id,x,y,排队毫秒"。无轨模式的判定要 y，
       所以从 RhythmLabShell/4 起多发一段；页面两种长度都认。 */
    private void send(String type, int id, float xPx, float yPx, float age) {
        if (batchCount > 0) batch.append(';');
        batch.append(type).append(',').append(id).append(',')
             .append(Math.round(xPx / density * 10) / 10f).append(',')
             .append(Math.round(yPx / density * 10) / 10f).append(',')
             .append(Math.round(age));
        batchCount++;
        // 攒太多就立刻发，别让一帧内的爆发拖到下一帧
        if (batchCount >= 32) { web.removeCallbacks(flush); flush.run(); return; }
        if (!flushScheduled) { flushScheduled = true; web.post(flush); }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != REQ_FILE) { super.onActivityResult(req, res, data); return; }
        ValueCallback<Uri[]> cb = filePicker;
        filePicker = null;
        if (cb != null) {
            // 取消（RESULT_CANCELED）也要回一次 null，否则 input 永久卡在「选择中」
            cb.onReceiveValue(res == RESULT_OK
                    ? WebChromeClient.FileChooserParams.parseResult(res, data) : null);
        }
        applyImmersive();   // 选择器是另一个 Activity，回来时系统栏还露在外面
    }

    @Override protected void onResume() { super.onResume(); applyImmersive(); }
    @Override public void onWindowFocusChanged(boolean has) {
        super.onWindowFocusChanged(has);
        if (has) { applyImmersive(); applyGestureExclusion(); }
    }
    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    /** 极简的 int->float 映射，免得为几个手指引入集合类开销。 */
    private static final class SparseFloats {
        private final int[] ids = new int[16];
        private final float[] vals = new float[16];
        private int n = 0;
        void put(int id, float v) {
            for (int i = 0; i < n; i++) if (ids[i] == id) { vals[i] = v; return; }
            if (n < ids.length) { ids[n] = id; vals[n] = v; n++; }
        }
        float get(int id) {
            for (int i = 0; i < n; i++) if (ids[i] == id) return vals[i];
            return -1e9f;
        }
        void remove(int id) {
            for (int i = 0; i < n; i++) if (ids[i] == id) { ids[i] = ids[n - 1]; vals[i] = vals[n - 1]; n--; return; }
        }
    }
}
