package com.rookiehouse.lingji.preview;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.content.res.ColorStateList;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewTreeObserver;
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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private static final String HOST = "lingji.rookiehouse.com";
    private static final String PAGE = "https://" + HOST + "/quick-record";
    private static final int LIGHT = 0xfff5f7f4;
    private static final int DARK = 0xff171b19;
    private static final int MIC = 10;
    private static final int FILE = 11;
    private WebView web;
    private FrameLayout frame;
    private LinearLayout launch;
    private TextView status;
    private Button retry;
    private int pageAttempt;
    private boolean dark;
    private final Runnable timeout = () -> retry.setVisibility(View.VISIBLE);
    private WebMessagePort recordingPort;
    private boolean recordingBridgeReady;
    private PermissionRequest microphone;
    private ValueCallback<Uri[]> files;

    private static boolean trusted(Uri url) {
        return "https".equals(url.getScheme()) && HOST.equals(url.getHost())
            && url.getUserInfo() == null && (url.getPort() == -1 || url.getPort() == 443);
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
        frame.getViewTreeObserver().addOnDrawListener(new ViewTreeObserver.OnDrawListener() {
            private boolean scheduled;
            @Override public void onDraw() {
                if (scheduled) return;
                scheduled = true;
                frame.post(() -> {
                    frame.getViewTreeObserver().removeOnDrawListener(this);
                    if (!isFinishing() && !isDestroyed()) openWeb(saved);
                });
            }
        });
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void buildLaunch() {
        launch = new LinearLayout(this);
        launch.setOrientation(LinearLayout.VERTICAL);
        launch.setGravity(Gravity.CENTER);
        launch.setPadding(dp(24), dp(24), dp(24), dp(24));
        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("lingji", "drawable", getPackageName()));
        launch.addView(logo, new LinearLayout.LayoutParams(dp(52), dp(52)));
        status = new TextView(this);
        status.setTextSize(14);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams label = new LinearLayout.LayoutParams(-2, -2);
        label.topMargin = dp(8);
        launch.addView(status, label);
        retry = new Button(this);
        retry.setText("重新加载");
        retry.setVisibility(View.INVISIBLE);
        retry.setOnClickListener(view -> { if (web != null) web.loadUrl(PAGE); });
        LinearLayout.LayoutParams action = new LinearLayout.LayoutParams(-2, dp(48));
        action.topMargin = dp(12);
        launch.addView(retry, action);
        frame.addView(launch, new FrameLayout.LayoutParams(-1, -1));
    }

    private void paintChrome(boolean darkMode) {
        dark = darkMode;
        int background = dark ? DARK : LIGHT;
        getWindow().setBackgroundDrawable(new ColorDrawable(background));
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
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

    private void showLaunch(String message, boolean allowRetry) {
        frame.removeCallbacks(timeout);
        launch.setVisibility(View.VISIBLE);
        status.setText(message);
        status.setVisibility(message == null ? View.INVISIBLE : View.VISIBLE);
        retry.setVisibility(allowRetry ? View.VISIBLE : View.INVISIBLE);
        if (!allowRetry) frame.postDelayed(timeout, 8000);
    }

    private void reveal(WebView view, boolean darkMode) {
        paintChrome(darkMode);
        getPreferences(MODE_PRIVATE).edit().putBoolean("dark", darkMode).apply();
        int attempt = pageAttempt;
        view.postVisualStateCallback(attempt, new WebView.VisualStateCallback() {
            @Override public void onComplete(long id) {
                if (id == pageAttempt && !isDestroyed()) {
                    frame.removeCallbacks(timeout);
                    launch.setVisibility(View.GONE);
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
        settings.setDomStorageEnabled(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        WebView.setWebContentsDebuggingEnabled(false);
        web.setWebViewClient(new WebViewClient() {
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
                if ("/quick-record".equals(Uri.parse(url).getPath())) connectRecordingPort(view);
                int attempt = pageAttempt;
                view.evaluateJavascript(
                    "document.querySelector('#root')?.childElementCount ? document.documentElement.dataset.theme || 'light' : ''",
                    value -> {
                        if (attempt != pageAttempt || isDestroyed()) return;
                        if (value.equals("\"dark\"")) reveal(view, true);
                        else if (value.equals("\"light\"")) reveal(view, false);
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
                if ("聆记 · 快记".equals(title)) reveal(view, false);
                else if ("聆记 · 快记（深色）".equals(title)) reveal(view, true);
            }

            @Override public void onPermissionRequest(PermissionRequest request) {
                boolean audio = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audio = true;
                }
                if (!trusted(request.getOrigin()) || !audio || microphone != null || !hasWindowFocus()) {
                    request.deny();
                } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    grantMicrophone(request);
                } else {
                    microphone = request;
                    String[] permissions = Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
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

    private void connectRecordingPort(WebView view) {
        if (recordingPort != null) return;
        WebMessagePort[] ports = view.createWebMessageChannel();
        recordingPort = ports[0];
        recordingPort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override public void onMessage(WebMessagePort port, WebMessage message) {
                if (port != recordingPort) return;
                switch (message.getData()) {
                    case "ready":
                        recordingBridgeReady = true;
                        break;
                    case "start":
                        if (recordingBridgeReady && hasWindowFocus()
                            && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            try {
                                startForegroundService(new Intent(MainActivity.this, RecordingService.class));
                            } catch (IllegalStateException | SecurityException ignored) {
                                // A system transition can end while-in-use permission before dispatch.
                            }
                        }
                        break;
                    case "stop":
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
        if (recordingPort != null) {
            recordingPort.close();
            recordingPort = null;
        }
        stopService(new Intent(this, RecordingService.class));
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != MIC || microphone == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            grantMicrophone(microphone);
        } else {
            microphone.deny();
        }
        microphone = null;
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != FILE || files == null) return;
        files.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        files = null;
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        if (web != null) web.saveState(state);
        super.onSaveInstanceState(state);
    }

    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override protected void onDestroy() {
        closeRecordingPort();
        if (microphone != null) microphone.deny();
        if (files != null) files.onReceiveValue(null);
        if (frame != null) frame.removeCallbacks(timeout);
        if (web != null) {
            frame.removeView(web);
            web.destroy();
        }
        super.onDestroy();
    }
}
