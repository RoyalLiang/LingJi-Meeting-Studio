package com.rookiehouse.lingji.preview;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.NoiseSuppressor;
import android.os.PowerManager;
import android.os.Process;
import android.util.Base64;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;

/** Records independently of WebView scheduling. The page drains completed PCM blocks. */
final class NativeMicrophone {
    private static final int RATE = 16000;
    private static final int BLOCK = RATE / 4;
    private static final long WAV_LIMIT = 0xffffffdaL;
    private final File file;
    private final PowerManager.WakeLock lock;
    final String id;
    volatile boolean paused, ending, ready, done;
    private volatile AudioRecord input;
    private volatile long available;
    private volatile boolean failed;

    NativeMicrophone(Context context, String id) {
        this.id = id;
        file = new File(context.getCacheDir(), "recording-" + id + ".pcm");
        lock = context.getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LingJi:recording");
        lock.setReferenceCounted(false);
    }

    void start(Context context) {
        lock.acquire();
        new Thread(() -> capture(context.getSystemService(AudioManager.class)), "lingji-native-microphone").start();
    }

    private static AudioRecord open(int mask) {
        int min = AudioRecord.getMinBufferSize(RATE, mask, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) throw new IllegalStateException("Unsupported microphone format");
        AudioRecord record = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
            RATE, mask, AudioFormat.ENCODING_PCM_16BIT, Math.max(min * 2, BLOCK * 8));
        if (record.getState() == AudioRecord.STATE_INITIALIZED) return record;
        record.release();
        throw new IllegalStateException("Microphone unavailable");
    }

    private static AudioRecord openMicrophone(AudioManager manager) {
        for (AudioDeviceInfo device : manager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            if (device.getType() != AudioDeviceInfo.TYPE_BUILTIN_MIC) continue;
            for (int count : device.getChannelCounts()) {
                if (count != 2) continue;
                try { return open(AudioFormat.CHANNEL_IN_STEREO); }
                catch (RuntimeException unsupported) { return open(AudioFormat.CHANNEL_IN_MONO); }
            }
        }
        return open(AudioFormat.CHANNEL_IN_MONO);
    }

    private void capture(AudioManager manager) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
        AudioRecord recorder = null;
        NoiseSuppressor noise = null;
        try (FileOutputStream output = new FileOutputStream(file)) {
            recorder = openMicrophone(manager);
            input = recorder;
            if (NoiseSuppressor.isAvailable()) {
                try {
                    noise = NoiseSuppressor.create(recorder.getAudioSessionId());
                    if (noise != null) noise.setEnabled(true);
                } catch (RuntimeException ignored) {}
            }
            int channels = recorder.getChannelCount();
            short[] samples = new short[BLOCK * channels];
            byte[] pcm = new byte[BLOCK * 2];
            double previous = 0, filtered = 0;
            if (ending) return;
            recorder.startRecording();
            if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IllegalStateException("Microphone capture did not start");
            ready = true;
            while (!ending && available < WAV_LIMIT) {
                final int count = recorder.read(samples, 0, samples.length, AudioRecord.READ_BLOCKING);
                if (count <= 0) {
                    if (ending) break;
                    throw new IOException("Microphone read failed");
                }
                if (paused) { previous = filtered = 0; continue; }
                final int frames = (int)Math.min(count / channels, (WAV_LIMIT - available) / 2);
                long correlation = 0;
                if (channels == 2) {
                    for (int i = 0; i < frames; i++) correlation += (long)samples[i * 2] * samples[i * 2 + 1];
                }
                for (int i = 0; i < frames; i++) {
                    double sample = samples[i * channels];
                    // A phase-opposed stereo route would cancel speech if averaged.
                    if (channels == 2 && correlation >= 0) sample = (sample + samples[i * 2 + 1]) * .5;
                    filtered = .974 * (filtered + sample - previous);
                    previous = sample;
                    int value = (int)Math.max(-32768, Math.min(32767, Math.round(filtered)));
                    pcm[i * 2] = (byte)value;
                    pcm[i * 2 + 1] = (byte)(value >> 8);
                }
                output.write(pcm, 0, frames * 2);
                available += frames * 2;
            }
            output.getFD().sync();
        } catch (IOException | RuntimeException failure) {
            failed = true;
        } finally {
            input = null;
            if (noise != null) noise.release();
            if (recorder != null) recorder.release();
            if (lock.isHeld()) lock.release();
            done = true;
        }
    }

    String read(long offset) {
        long length = available;
        if (offset < 0 || offset > length || offset % 2 != 0) return "error";
        int size = (int)Math.min(length - offset, RATE * 2);
        if (!done && size != RATE * 2) return ready ? "wait" : "starting";
        if (size == 0) return failed ? "error" : "end";
        byte[] bytes = new byte[size];
        try (RandomAccessFile source = new RandomAccessFile(file, "r")) {
            source.seek(offset);
            source.readFully(bytes);
            return Base64.encodeToString(bytes, Base64.NO_WRAP);
        } catch (IOException failure) {
            return "error";
        }
    }

    void stop() {
        ending = true;
        AudioRecord active = input;
        if (active != null) {
            try { active.stop(); } catch (IllegalStateException ignored) {}
        }
    }

    boolean release() {
        return done && (!file.exists() || file.delete());
    }
}
