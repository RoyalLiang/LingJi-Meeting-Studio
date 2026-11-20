package com.rookiehouse.lingji.preview;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public final class MainActivity extends Activity {
    private static final String HOST = "lingji.rookiehouse.com";
    private static final int MIC = 10;
    private static final int FILE = 11;
    private WebView web;
    private PermissionRequest microphone;
    private ValueCallback<Uri[]> files;

    private static boolean trusted(Uri url) {
        return "https".equals(url.getScheme()) && HOST.equals(url.getHost())
            && url.getUserInfo() == null && (url.getPort() == -1 || url.getPort() == 443);
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        // Keep foreground test recordings running while the user reads another tab.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
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
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                boolean audio = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audio = true;
                }
                if (!trusted(request.getOrigin()) || !audio || microphone != null) {
                    request.deny();
                } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    microphone = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC);
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
        setContentView(web);
        if (saved == null || web.restoreState(saved) == null) web.loadUrl("https://" + HOST + "/quick-record");
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != MIC || microphone == null) return;
        if (results.length == 1 && results[0] == PackageManager.PERMISSION_GRANTED) {
            microphone.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
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
        web.saveState(state);
        super.onSaveInstanceState(state);
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (microphone != null) microphone.deny();
        if (files != null) files.onReceiveValue(null);
        web.destroy();
        super.onDestroy();
    }
}
