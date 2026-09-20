package ren.pekka.rhythmlab;

import android.app.Activity;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
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
 * 它只解决网页端解决不了的三件事：
 *   1. setSystemGestureExclusionRects —— 把屏幕左右边缘从系统手势里划出来，
 *      安卓手势导航不再抢走最外侧轨道的触摸（网页端只能靠留白躲开）。
 *   2. 原生 MotionEvent 直采 —— 在 Activity 层拿到每一个 ACTION_DOWN /
 *      ACTION_POINTER_DOWN，用 event.getEventTime() 的真实时刻转发给 JS，
 *      不经过 WebView 的 DOM 事件管线。
 *   3. 常亮 + 沉浸式全屏 —— 没有地址栏伸缩、没有下拉刷新。
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

    private float density = 2f;
    private boolean secure = false;
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
        web.addJavascriptInterface(new Shell(), "RLShell");
        // UA 打个标记：页面据此知道自己跑在原生壳里，桥没注入上时也能把问题显出来
        st.setUserAgentString(st.getUserAgentString() + " RhythmLabShell/2");
        st.setSupportZoom(false);
        st.setBuiltInZoomControls(false);
        st.setCacheMode(WebSettings.LOAD_NO_CACHE);
        st.setAllowFileAccess(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);
        WebView.setWebContentsDebuggingEnabled(true);

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
            @Override public void onSystemUiVisibilityChange(int visibility) { applyImmersive(); }
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

    /** 有些 ROM 的三指截屏/多指手势检测会在识别期间把触摸从 App 手里扣住，
     *  表现就是多指连点时整段收不到事件。窗口标为 SECURE 后截屏被禁，
     *  这类检测在部分 ROM 上会直接不再拦截。是实验开关，不是常规设置。 */
    public final class Shell {
        @android.webkit.JavascriptInterface
        public void setSecure(final boolean on) {
            runOnUiThread(new Runnable() { public void run() { applySecure(on); } });
        }
        @android.webkit.JavascriptInterface
        public boolean isSecure() { return secure; }
    }

    private void applySecure(boolean on) {
        secure = on;
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
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
        } catch (Throwable ignored) {
            // 拿不到就算了，页面端还有留白兜底
        }
    }

    /** 原生触摸直采：不消费，只是抢先把每一个按下/抬起/移动转发给 JS。 */
    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        try { forward(ev); } catch (Throwable ignored) { }
        return super.dispatchTouchEvent(ev);
    }

    private void forward(MotionEvent ev) {
        if (web == null) return;
        final int action = ev.getActionMasked();
        // 事件已经排队了多久：JS 端用 performance.now() - age 还原真实时刻
        final float age = SystemClock.uptimeMillis() - ev.getEventTime();

        switch (action) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_POINTER_DOWN: {
                int i = ev.getActionIndex();
                send("d", ev.getPointerId(i), ev.getX(i), age);
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
                    send("m", id, x, age);
                }
                break;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_POINTER_UP:
            case MotionEvent.ACTION_CANCEL: {
                int i = ev.getActionIndex();
                send("u", ev.getPointerId(i), ev.getX(i), age);
                lastSentX.remove(ev.getPointerId(i));
                break;
            }
            default:
                break;
        }
    }

    private void send(String type, int id, float xPx, float age) {
        final String js = "window.MG&&MG.nativeTouch&&MG.nativeTouch('" + type + "'," + id
                + "," + (xPx / density) + "," + age + ")";
        web.evaluateJavascript(js, null);
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
