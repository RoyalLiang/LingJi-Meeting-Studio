package com.rookiehouse.lingji.preview;

import android.app.Service;
import android.content.Intent;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioRecordingConfiguration;
import android.media.MediaRecorder;
import android.media.audiofx.NoiseSuppressor;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

public final class MeetingCaptureService extends Service {
    private static final int RATE = 16000;
    private static final int SAMPLES = RATE / 4;
    static Consumer<String> messages;
    private static MeetingCaptureService active;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicInteger queued = new AtomicInteger();
    private volatile AudioRecord input;
    private volatile boolean running, paused;

    static void acknowledge() {
        if (active != null) active.queued.updateAndGet(count -> Math.max(0, count - 1));
    }

    static void changePause(boolean pause, int elapsed) {
        if (active == null) return;
        active.paused = pause;
        active.showStatus(pause, elapsed, null);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (running) return START_NOT_STICKY;
        showStatus(false, 0, "等待会议通话");
        active = this;
        running = true;
        new Thread(this::monitor, "lingji-meeting-audio").start();
        return START_NOT_STICKY;
    }

    private boolean inMeeting(AudioManager audio) {
        return MeetingCallListener.inMeeting() && audio.getMode() == AudioManager.MODE_IN_COMMUNICATION;
    }

    private void monitor() {
        AudioManager audio = getSystemService(AudioManager.class);
        int calls = 0;
        long deadline = SystemClock.elapsedRealtime() + 5000;
        try {
            while (running && !MeetingCallListener.connected() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(250);
            main.post(() -> { if (running) send("system-audio-armed"); });
            while (running && MeetingCallListener.connected() && calls < 4) {
                calls = inMeeting(audio) ? calls + 1 : 0;
                SystemClock.sleep(250);
            }
            if (running && MeetingCallListener.connected()) capture(audio);
            if (running && !MeetingCallListener.connected()) report("system-audio-error:通话通知授权已关闭");
        } catch (RuntimeException failure) {
            if (running) report("system-audio-error:麦克风暂时不可用，已接收片段会保存");
        } finally {
            main.post(this::stopSelf);
        }
    }

    private void capture(AudioManager audio) {
        int minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
            RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, SAMPLES * 8));
        input = recorder;
        NoiseSuppressor noise = null;
        short[] samples = new short[SAMPLES];
        boolean started = false, warned = false;
        long endedAt = 0;
        try {
            if (!running) return;
            if (NoiseSuppressor.isAvailable()) {
                try {
                    noise = NoiseSuppressor.create(recorder.getAudioSessionId());
                    if (noise != null) noise.setEnabled(true);
                } catch (RuntimeException ignored) {}
            }
            recorder.startRecording();
            while (running && MeetingCallListener.connected()) {
                int size = 0;
                while (running && size < SAMPLES) {
                    int count = recorder.read(samples, size, SAMPLES - size, AudioRecord.READ_BLOCKING);
                    if (count <= 0) throw new IllegalStateException("Audio read interrupted");
                    size += count;
                }
                if (!running) break;
                if (!inMeeting(audio)) {
                    long now = SystemClock.elapsedRealtime();
                    if (endedAt == 0) endedAt = now;
                    if (now - endedAt >= 10_000) return;
                    continue;
                }
                endedAt = 0;
                AudioRecordingConfiguration config = recorder.getActiveRecordingConfiguration();
                if (config == null || config.isClientSilenced()) {
                    if (!warned) report("system-audio-warning:会议应用正在占用麦克风，等待 Android 开放收音");
                    warned = true;
                    continue;
                }
                if (paused) continue;
                if (!started) {
                    started = true;
                    main.post(() -> {
                        if (!running) return;
                        showStatus(false, 0, null);
                        send("system-audio-detected");
                    });
                }
                queue(samples);
            }
        } finally {
            input = null;
            if (noise != null) noise.release();
            recorder.release();
        }
    }

    private void queue(short[] samples) {
        if (queued.incrementAndGet() > 32) throw new IllegalStateException("Mobile recorder stalled");
        byte[] bytes = new byte[SAMPLES * 2];
        for (int i = 0; i < SAMPLES; i++) {
            bytes[2 * i] = (byte)samples[i];
            bytes[2 * i + 1] = (byte)(samples[i] >> 8);
        }
        String data = Base64.encodeToString(bytes, Base64.NO_WRAP);
        main.post(() -> { if (running) send("system-audio-frame:" + data); });
    }

    private void showStatus(boolean pause, int elapsed, String waiting) {
        startForeground(2, RecordingService.notification(this, pause, elapsed, waiting));
    }

    private void report(String message) { main.post(() -> { if (running) send(message); }); }

    private static void send(String message) {
        if (messages != null) messages.accept(message);
    }

    @Override public void onDestroy() {
        running = false;
        if (active == this) active = null;
        AudioRecord recorder = input;
        if (recorder != null) {
            try { recorder.stop(); } catch (IllegalStateException ignored) {}
        }
        send("system-audio-ended");
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
