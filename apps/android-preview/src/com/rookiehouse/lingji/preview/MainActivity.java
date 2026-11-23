package com.rookiehouse.lingji.preview;

import android.Manifest;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.content.res.ColorStateList;
import android.graphics.drawable.ColorDrawable;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.window.SplashScreenView;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;
import java.io.IOException;
import java.io.InputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.Inet4Address;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;

public final class MainActivity extends Activity {
    private static final String HOST = "lingji.rookiehouse.com";
    private static final String APP_PATH = "/mobile-app";
    private static final String PAGE = "https://" + HOST + APP_PATH;
    private static final String ASSET_ROOT = "mobile/";
    private static final String CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'";
    private static final int LIGHT = 0xfff4f4f5;
    private static final int DARK = 0xff1a1a1c;
    private static final String LIGHT_TITLE = "聆记 · 快记";
    private static final String DARK_TITLE = "聆记 · 快记（深色）";
    private static final int MIC = 10;
    private static final int FILE = 11;
    private static final int NOTIFICATIONS = 12;
    private static final int SYSTEM_AUDIO_PERMISSION = 13;
    private static final int MEETING_NOTIFICATION_SETTINGS = 14;
    private static final int NATIVE_MIC = 15;
    private WebView web;
    private FrameLayout frame;
    private FrameLayout launch;
    private TextView status;
    private Button retry;
    private SplashScreenView startupSplash;
    private int pageAttempt;
    private int revealingAttempt = -1;
    private boolean dark;
    private boolean sheetOpen;
    private boolean resumed;
    private boolean pendingRecordingStart;
    private String pendingNativeCapture;
    private boolean pendingMeetingStart;
    private final Runnable timeout = () -> {
        retry.setVisibility(View.VISIBLE);
        dismissStartupSplash();
    };
    private WebMessagePort recordingPort;
    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        private Network validatedNetwork;

        @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
            if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) || network.equals(validatedNetwork)) return;
            boolean switched = validatedNetwork != null;
            validatedNetwork = network;
            if (switched && recordingBridgeReady && recordingPort != null) {
                recordingPort.postMessage(new WebMessage("network-changed"));
            }
        }
    };
    private boolean recordingBridgeReady;
    private PermissionRequest microphone;
    private ValueCallback<Uri[]> files;

    private JSONArray directAddresses() {
        JSONArray addresses = new JSONArray();
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        Network network = manager.getActiveNetwork();
        if (network == null) return addresses;
        NetworkCapabilities caps = manager.getNetworkCapabilities(network);
        if (caps == null || !(caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) return addresses;
        LinkProperties link = manager.getLinkProperties(network);
        if (link != null) for (LinkAddress address : link.getLinkAddresses()) {
            if (address.getAddress() instanceof Inet4Address && address.getAddress().isSiteLocalAddress()) {
                addresses.put(address.getAddress().getHostAddress());
            }
        }
        return addresses;
    }

    private static boolean trusted(Uri url) {
        return "https".equals(url.getScheme()) && HOST.equals(url.getHost())
            && url.getUserInfo() == null && (url.getPort() == -1 || url.getPort() == 443);
    }

    private static String safeAssetPath(String rawPath) {
        if (rawPath == null || rawPath.isEmpty() || APP_PATH.equals(rawPath)) {
            return ASSET_ROOT + "mobile-app.html";
        }
        if (rawPath.startsWith("/api/") || rawPath.contains("\\") || rawPath.contains("\0")) {
            return null;
        }
        String trimmed = rawPath.startsWith("/") ? rawPath.substring(1) : rawPath;
        if (trimmed.isEmpty()) return null;
        String[] parts = trimmed.split("/");
        for (String part : parts) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) return null;
        }
        return ASSET_ROOT + trimmed;
    }

    private static String mimeFor(String assetPath) {
        if (assetPath.endsWith(".html")) return "text/html";
        if (assetPath.endsWith(".js") || assetPath.endsWith(".mjs")) return "text/javascript";
        if (assetPath.endsWith(".css")) return "text/css";
        if (assetPath.endsWith(".wasm")) return "application/wasm";
        if (assetPath.endsWith(".svg")) return "image/svg+xml";
        if (assetPath.endsWith(".png")) return "image/png";
        if (assetPath.endsWith(".json")) return "application/json";
        if (assetPath.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private WebResourceResponse serveLocalAsset(WebResourceRequest request) {
        if (!"GET".equalsIgnoreCase(request.getMethod())) return null;
        Uri url = request.getUrl();
        if (!trusted(url)) return null;
        String assetPath = safeAssetPath(url.getPath());
        if (assetPath == null) return null;
        try {
            InputStream stream = getAssets().open(assetPath);
            String mime = mimeFor(assetPath);
            String encoding = (mime.startsWith("text/") || "application/json".equals(mime) || "image/svg+xml".equals(mime)) ? "utf-8" : null;
            Map<String, String> headers = new HashMap<>();
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("Referrer-Policy", "no-referrer");
            if (assetPath.endsWith(".html")) {
                headers.put("Content-Security-Policy", CSP);
                headers.put("Cache-Control", "no-cache");
            } else {
                headers.put("Cache-Control", "public, max-age=31536000, immutable");
            }
            return new WebResourceResponse(mime, encoding, 200, "OK", headers, stream);
        } catch (IOException ignored) {
            return null;
        }
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        final boolean systemDark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES;
        dark = getPreferences(MODE_PRIVATE).getBoolean("dark", systemDark);
        frame = new FrameLayout(this);
        buildLaunch();
        paintChrome(dark);
        setContentView(frame);
        showLaunch(null, false);
        if (Build.VERSION.SDK_INT >= 31) {
            getSplashScreen().setOnExitAnimationListener(splash -> {
                startupSplash = splash;
                if (retry.getVisibility() == View.VISIBLE || launch.getVisibility() != View.VISIBLE) dismissStartupSplash();
                else if (revealingAttempt == pageAttempt) animateReveal(pageAttempt);
            });
        }
        // Start WebView creation immediately in onCreate so local APK assets load on the first frame.
        openWeb(saved);
        getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(networkCallback, new Handler(getMainLooper()));
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        flushPendingRecordingStart();
        flushPendingMeetingStart();
    }

    @Override protected void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            flushPendingRecordingStart();
            flushPendingMeetingStart();
        }
    }

    private void flushPendingRecordingStart() {
        if ((!pendingRecordingStart && pendingNativeCapture == null) || !recordingBridgeReady || !(resumed || hasWindowFocus())) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return;
        pendingRecordingStart = false;
        String id = pendingNativeCapture;
        pendingNativeCapture = null;
        try {
            startForegroundService(new Intent(MainActivity.this, RecordingService.class).putExtra("capture", id));
        } catch (IllegalStateException | SecurityException ignored) {
            if (id != null) postToRecorder("native:" + id + ":error");
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void buildLaunch() {
        launch = new FrameLayout(this);
        launch.setPadding(dp(24), dp(24), dp(24), dp(24));
        status = new TextView(this);
        status.setTextSize(14);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setGravity(Gravity.CENTER);
        launch.addView(status, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
        retry = new Button(this);
        retry.setText("重新加载");
        retry.setVisibility(View.INVISIBLE);
        retry.setOnClickListener(view -> { if (web != null) web.loadUrl(PAGE); });
        retry.setTranslationY(dp(50));
        launch.addView(retry, new FrameLayout.LayoutParams(-2, dp(48), Gravity.CENTER));
        frame.addView(launch, new FrameLayout.LayoutParams(-1, -1));
    }

    private void paintChrome(boolean darkMode) {
        dark = darkMode;
        int background = dark ? DARK : LIGHT;
        getWindow().setBackgroundDrawable(new ColorDrawable(background));
        paintSystemBars();
        int mask = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility((decor.getSystemUiVisibility() & ~mask) | (dark ? 0 : mask));
        frame.setBackgroundColor(background);
        launch.setBackgroundColor(background);
        status.setTextColor(dark ? 0xffafbbb2 : 0xff53635a);
        retry.setTextColor(dark ? 0xffecf2ed : 0xff19231e);
        retry.setBackgroundTintList(ColorStateList.valueOf(dark ? 0xff29352e : 0xffe4ebe3));
        if (web != null) web.setBackgroundColor(background);
    }

    private void paintSystemBars() {
        int color = dark ? (sheetOpen ? 0xff141415 : DARK) : (sheetOpen ? 0xffb9b9ba : LIGHT);
        getWindow().setStatusBarColor(color);
        getWindow().setNavigationBarColor(color);
    }

    private void showLaunch(String message, boolean allowRetry) {
        frame.removeCallbacks(timeout);
        launch.animate().cancel();
        launch.setAlpha(1f);
        if (startupSplash != null) {
            startupSplash.animate().cancel();
            startupSplash.setAlpha(1f);
        }
        revealingAttempt = -1;
        launch.setVisibility(View.VISIBLE);
        status.setText(message);
        status.setVisibility(message == null ? View.INVISIBLE : View.VISIBLE);
        retry.setVisibility(allowRetry ? View.VISIBLE : View.INVISIBLE);
        if (allowRetry) dismissStartupSplash();
        else frame.postDelayed(timeout, 8000);
    }

    private void fadeLaunch(View cover, long duration, Runnable end) {
        cover.animate().alpha(0f).setDuration(duration)
                .setInterpolator(new AccelerateDecelerateInterpolator()).withEndAction(end).start();
    }

    private void dismissStartupSplash() {
        SplashScreenView splash = startupSplash;
        if (splash == null) return;
        startupSplash = null;
        splash.animate().cancel();
        splash.remove();
    }

    private void animateReveal(int attempt) {
        launch.animate().cancel();
        launch.setAlpha(1f);
        if (!ValueAnimator.areAnimatorsEnabled()) {
            dismissStartupSplash();
            launch.setVisibility(View.GONE);
        } else if (startupSplash == null) {
            fadeLaunch(launch, 360, () -> launch.setVisibility(View.GONE));
        } else {
            // The opaque cover separates the Logo fade from the first visible WebView frame.
            fadeLaunch(startupSplash, 440, () -> {
                dismissStartupSplash();
                frame.postOnAnimation(() -> {
                    if (pageAttempt == attempt && revealingAttempt == attempt && !isDestroyed()) {
                        fadeLaunch(launch, 360, () -> launch.setVisibility(View.GONE));
                    }
                });
            });
        }
    }

    private void reveal(WebView view, boolean darkMode) {
        if (dark != darkMode) paintChrome(darkMode);
        else if (launch.getVisibility() != View.VISIBLE) return;
        getPreferences(MODE_PRIVATE).edit().putBoolean("dark", darkMode).apply();
        int attempt = pageAttempt;
        view.postVisualStateCallback(attempt, new WebView.VisualStateCallback() {
            @Override public void onComplete(long id) {
                if (id == pageAttempt && !isDestroyed() && revealingAttempt != id && launch.getVisibility() == View.VISIBLE) {
                    frame.removeCallbacks(timeout);
                    revealingAttempt = pageAttempt;
                    animateReveal(attempt);
                }
            }
        });
    }

    private void openWeb(Bundle saved) {
        web = new WebView(this);
        web.setBackgroundColor(dark ? DARK : LIGHT);
        frame.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        try {
            settings.setUserAgentString(settings.getUserAgentString() + " LingJi-Android/"
                + getPackageManager().getPackageInfo(getPackageName(), 0).versionName);
        } catch (PackageManager.NameNotFoundException impossible) {
            settings.setUserAgentString(settings.getUserAgentString() + " LingJi-Android");
        }
        settings.setDomStorageEnabled(true);
        // Playback of the tapped recording starts after its local audio is decrypted.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        WebView.setWebContentsDebuggingEnabled(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse local = serveLocalAsset(request);
                return local != null ? local : super.shouldInterceptRequest(view, request);
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !trusted(request.getUrl());
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                pageAttempt++;
                closeRecordingPort();
                showLaunch(null, false);
            }

            @Override public void onPageFinished(WebView view, String url) {
                if (!trusted(Uri.parse(url))) return;
                if (APP_PATH.equals(Uri.parse(url).getPath())) connectRecordingPort(view);
                int attempt = pageAttempt;
                view.evaluateJavascript("document.title",
                    value -> {
                        if (attempt != pageAttempt || isDestroyed()) return;
                        if (value.equals("\"" + DARK_TITLE + "\"")) reveal(view, true);
                        else if (value.equals("\"" + LIGHT_TITLE + "\"")) reveal(view, false);
                    });
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showLaunch("暂时无法连接，请检查网络", true);
            }

            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (request.isForMainFrame()) showLaunch("暂时无法打开录音工作台", true);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onReceivedTitle(WebView view, String title) {
                if (view.getUrl() == null || !trusted(Uri.parse(view.getUrl()))) return;
                if (LIGHT_TITLE.equals(title)) reveal(view, false);
                else if (DARK_TITLE.equals(title)) reveal(view, true);
            }

            @Override public void onPermissionRequest(PermissionRequest request) {
                boolean audio = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audio = true;
                }
                if (!trusted(request.getOrigin()) || !audio || microphone != null || !(resumed || hasWindowFocus())) {
                    request.deny();
                } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    if (askForNotifications()) {
                        microphone = request;
                        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATIONS);
                        return;
                    }
                    grantMicrophone(request);
                } else {
                    microphone = request;
                    String[] permissions = askForNotifications()
                        ? new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS}
                        : new String[]{Manifest.permission.RECORD_AUDIO};
                    requestPermissions(permissions, MIC);
                }
            }

            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (microphone == request) microphone = null;
            }

            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> result, FileChooserParams chooser) {
                if (files != null || view.getUrl() == null || !trusted(Uri.parse(view.getUrl()))) return false;
                try {
                    startActivityForResult(chooser.createIntent(), FILE);
                    files = result;
                    return true;
                } catch (ActivityNotFoundException error) {
                    return false;
                }
            }
        });
        if (saved == null || web.restoreState(saved) == null) web.loadUrl(PAGE);
    }

    private void grantMicrophone(PermissionRequest request) {
        try {
            if (recordingBridgeReady) startForegroundService(new Intent(this, RecordingService.class));
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } catch (IllegalStateException | SecurityException error) {
            request.deny();
        }
    }

    private boolean askForNotifications() {
        if (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
                || getPreferences(MODE_PRIVATE).getBoolean("notificationPrompted", false)) return false;
        getPreferences(MODE_PRIVATE).edit().putBoolean("notificationPrompted", true).apply();
        return true;
    }

    private void connectRecordingPort(WebView view) {
        if (recordingPort != null) return;
        WebMessagePort[] ports = view.createWebMessageChannel();
        recordingPort = ports[0];
        recordingPort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override public void onMessage(WebMessagePort port, WebMessage message) {
                if (port != recordingPort) return;
                String data = message.getData();
                if (data == null) return;
                if (data.matches("native-(?:start|finish):[a-f0-9-]{36}")) {
                    String id = data.substring(data.indexOf(':') + 1);
                    if (data.startsWith("native-finish:")) RecordingService.finish(id);
                    else requestNativeCapture(id);
                    return;
                }
                if (data.matches("native-read:[a-f0-9-]{36}:[0-9]{1,10}")) {
                    String[] fields = data.split(":");
                    postToRecorder("native:" + fields[1] + ":" + RecordingService.read(fields[1], Long.parseLong(fields[2])));
                    return;
                }
                if (data.matches("(?:pause|resume):[0-9]{1,7}")) {
                    if (resumed || hasWindowFocus()) {
                        try {
                            startService(new Intent(MainActivity.this, RecordingService.class)
                                .putExtra("paused", data.startsWith("pause:"))
                                .putExtra("elapsed", Integer.parseInt(data.substring(data.indexOf(':') + 1))));
                        } catch (IllegalStateException | SecurityException ignored) {}
                    }
                    return;
                }
                if (data.matches("system-(?:pause|resume):[0-9]{1,7}")) {
                    MeetingCaptureService.changePause(data.startsWith("system-pause:"), Integer.parseInt(data.substring(data.indexOf(':') + 1)));
                    return;
                }
                if (data.matches("check-update:[a-f0-9-]{36}")) {
                    String id = data.substring("check-update:".length());
                    new Thread(() -> {
                        String result = checkAndroidUpdate();
                        runOnUiThread(() -> {
                            if (port == recordingPort) port.postMessage(new WebMessage("update-result:" + id + ":" + result));
                        });
                    }, "lingji-update-check").start();
                    return;
                }
                switch (data) {
                    case "direct-addresses":
                        postToRecorder("direct-addresses:" + directAddresses());
                        break;
                    case "ready":
                        recordingBridgeReady = true;
                        MeetingCaptureService.messages = MainActivity.this::postToRecorder;
                        flushPendingRecordingStart();
                        break;
                    case "system-audio-arm":
                        requestSystemAudio();
                        break;
                    case "system-audio-disarm":
                        pendingMeetingStart = false;
                        stopService(new Intent(MainActivity.this, MeetingCaptureService.class));
                        break;
                    case "system-audio-ack":
                        MeetingCaptureService.acknowledge();
                        break;
                    case "sheet-open":
                    case "sheet-closed":
                        sheetOpen = "sheet-open".equals(message.getData());
                        paintSystemBars();
                        break;
                    case "start":
                        stopService(new Intent(MainActivity.this, MeetingCaptureService.class));
                        pendingRecordingStart = true;
                        flushPendingRecordingStart();
                        break;
                    case "stop":
                        pendingRecordingStart = false;
                        pendingNativeCapture = null;
                        stopService(new Intent(MainActivity.this, RecordingService.class));
                        break;
                }
            }
        });
        view.postWebMessage(new WebMessage("lingji-recording", new WebMessagePort[]{ports[1]}),
            Uri.parse("https://" + HOST));
    }

    private void closeRecordingPort() {
        recordingBridgeReady = false;
        sheetOpen = false;
        paintSystemBars();
        pendingRecordingStart = false;
        pendingNativeCapture = null;
        if (recordingPort != null) {
            recordingPort.close();
            recordingPort = null;
        }
        stopService(new Intent(this, RecordingService.class));
        pendingMeetingStart = false;
        MeetingCaptureService.messages = null;
        stopService(new Intent(this, MeetingCaptureService.class));
    }

    private void postToRecorder(String data) {
        if (recordingBridgeReady && recordingPort != null) recordingPort.postMessage(new WebMessage(data));
    }

    private void requestNativeCapture(String id) {
        if (!(resumed || hasWindowFocus()) || pendingNativeCapture != null) {
            postToRecorder("native:" + id + ":error");
            return;
        }
        stopService(new Intent(this, MeetingCaptureService.class));
        pendingNativeCapture = id;
        boolean microphonePermission = checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED;
        boolean notifications = askForNotifications();
        if (microphonePermission || notifications) {
            String[] permissions = microphonePermission && notifications
                ? new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS}
                : new String[]{microphonePermission ? Manifest.permission.RECORD_AUDIO : Manifest.permission.POST_NOTIFICATIONS};
            requestPermissions(permissions, NATIVE_MIC);
        } else flushPendingRecordingStart();
    }

    private ComponentName callListener() { return new ComponentName(this, MeetingCallListener.class); }

    private boolean hasCallAccess() {
        return getSystemService(NotificationManager.class).isNotificationListenerAccessGranted(callListener());
    }

    private void flushPendingMeetingStart() {
        if (!pendingMeetingStart || !recordingBridgeReady || !(resumed || hasWindowFocus())) return;
        pendingMeetingStart = false;
        requestSystemAudio();
    }

    private void requestSystemAudio() {
        if (Build.VERSION.SDK_INT < 29 || !(resumed || hasWindowFocus())) {
            postToRecorder("system-audio-error:自动记录需要 Android 10 或更新版本，请在聆记内授权");
            return;
        }
        if (!hasCallAccess()) {
            try {
                Intent settings = Build.VERSION.SDK_INT >= 30
                    ? new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                        .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, callListener().flattenToString())
                    : new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                startActivityForResult(settings, MEETING_NOTIFICATION_SETTINGS);
            } catch (ActivityNotFoundException failure) {
                postToRecorder("system-audio-error:请在 Android 设置中允许聆记读取通话通知");
            }
            return;
        }
        boolean microphonePermission = checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED;
        boolean notifications = askForNotifications();
        if (microphonePermission || notifications) {
            String[] permissions = microphonePermission && notifications
                ? new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS}
                : new String[]{microphonePermission ? Manifest.permission.RECORD_AUDIO : Manifest.permission.POST_NOTIFICATIONS};
            requestPermissions(permissions, SYSTEM_AUDIO_PERMISSION);
            return;
        }
        try {
            startForegroundService(new Intent(this, MeetingCaptureService.class));
        } catch (IllegalStateException | SecurityException failure) {
            postToRecorder("system-audio-error:请回到聆记后重新开始检测");
        }
    }

    private String checkAndroidUpdate() {
        HttpsURLConnection request = null;
        try {
            PackageInfo installed = getPackageManager().getPackageInfo(getPackageName(), 0);
            URL url = new URL("https://api.github.com/repos/RoyalLiang/LingJi-Meeting-Studio/releases?per_page=10");
            request = (HttpsURLConnection) url.openConnection();
            request.setConnectTimeout(5000);
            request.setReadTimeout(6000);
            request.setRequestProperty("Accept", "application/vnd.github+json");
            Pattern name = Pattern.compile("LingJi-Android-preview-v([1-9][0-9]{0,8})\\.apk");
            StringBuilder payload = new StringBuilder();
            try (BufferedReader body = new BufferedReader(new InputStreamReader(request.getInputStream(), "UTF-8"))) {
                char[] buffer = new char[4096];
                int count;
                while ((count = body.read(buffer)) != -1) {
                    if (payload.length() + count > 2_000_000) throw new IOException("Release response too large");
                    payload.append(buffer, 0, count);
                }
            }
            JSONArray releases = new JSONArray(payload.toString());
            int latest = 0;
            for (int i = 0; i < releases.length(); i++) {
                JSONArray assets = releases.getJSONObject(i).getJSONArray("assets");
                for (int j = 0; j < assets.length(); j++) {
                    Matcher version = name.matcher(assets.getJSONObject(j).getString("name"));
                    if (version.matches()) latest = Math.max(latest, Integer.parseInt(version.group(1)));
                }
            }
            if (latest == 0) return "empty";
            if (latest <= installed.getLongVersionCode()) return "current";
            return "available:" + latest;
        } catch (Exception failure) {
            return "error";
        } finally {
            if (request != null) request.disconnect();
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == NATIVE_MIC) {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) flushPendingRecordingStart();
            else {
                if (pendingNativeCapture != null) postToRecorder("native:" + pendingNativeCapture + ":permission");
                pendingNativeCapture = null;
            }
            return;
        }
        if (code == SYSTEM_AUDIO_PERMISSION) {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                pendingMeetingStart = true;
                flushPendingMeetingStart();
            } else postToRecorder("system-audio-error:请先允许录音权限");
            return;
        }
        if ((code != MIC && code != NOTIFICATIONS) || microphone == null) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            grantMicrophone(microphone);
        } else {
            microphone.deny();
        }
        microphone = null;
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == MEETING_NOTIFICATION_SETTINGS) {
            if (hasCallAccess()) {
                pendingMeetingStart = true;
                flushPendingMeetingStart();
            } else postToRecorder("system-audio-error:需要允许聆记读取通话通知才能检测会议");
            return;
        }
        if (code != FILE || files == null) return;
        files.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        files = null;
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        if (web != null) web.saveState(state);
        super.onSaveInstanceState(state);
    }

    @Override public void onBackPressed() {
        if (sheetOpen && recordingPort != null) {
            recordingPort.postMessage(new WebMessage("sheet-back"));
            return;
        }
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override protected void onDestroy() {
        dismissStartupSplash();
        getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networkCallback);
        closeRecordingPort();
        if (microphone != null) microphone.deny();
        if (files != null) files.onReceiveValue(null);
        if (frame != null) frame.removeCallbacks(timeout);
        if (launch != null) launch.animate().cancel();
        if (web != null) {
            frame.removeView(web);
            web.destroy();
        }
        super.onDestroy();
    }
}
