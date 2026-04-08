'use strict';

// ── Sound Editor ──────────────────────────────────────────────────────────
// Loads WAV/MP3/OGG audio files via Web Audio API, shows waveform preview,
// displays file properties, and will convert to 8-bit signed PCM (.sraw)
// for Amiga playback in a later milestone.
//
// Opened via double-click on a sound file in the Project Tree.

// ── State ─────────────────────────────────────────────────────────────────
let _sndAudioBuffer = null;  // decoded AudioBuffer
let _sndFilename    = '';    // output filename, e.g. "shoot.sraw"
let _sndSourceDir   = '';
let _sndProjectDir  = null;
let _sndSourceName  = '';    // original filename

// ── Helpers ───────────────────────────────────────────────────────────────

function _sndFormatDuration(seconds) {
    if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(2);
    return m > 0 ? `${m}:${s.padStart(5, '0')}` : `${s} s`;
}

function _sndPeriodToHz(period) {
    return Math.round(3546895 / period);
}

// ── Waveform rendering ───────────────────────────────────────────────────

function _sndDrawWaveform(canvas, audioBuffer) {
    const ctx = canvas.getContext('2d');
    const w   = canvas.width;
    const h   = canvas.height;

    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);

    if (!audioBuffer) return;

    // Mix down to mono for display
    const data = audioBuffer.getChannelData(0);
    const len  = data.length;
    const step = Math.max(1, Math.floor(len / w));
    const mid  = h / 2;

    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth   = 1;
    ctx.beginPath();

    for (let x = 0; x < w; x++) {
        const offset = Math.floor(x * len / w);
        let min = 1, max = -1;
        for (let j = 0; j < step && (offset + j) < len; j++) {
            const val = data[offset + j];
            if (val < min) min = val;
            if (val > max) max = val;
        }
        const y1 = mid - max * mid;
        const y2 = mid - min * mid;
        ctx.moveTo(x + 0.5, y1);
        ctx.lineTo(x + 0.5, y2);
    }
    ctx.stroke();

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
}

function _sndDrawConverted(canvas, audioBuffer) {
    const ctx = canvas.getContext('2d');
    const w   = canvas.width;
    const h   = canvas.height;

    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);

    if (!audioBuffer) {
        ctx.fillStyle = '#333';
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Conversion not yet implemented', w / 2, h / 2 + 4);
        return;
    }

    // Show a simulated 8-bit quantized view
    const data = audioBuffer.getChannelData(0);
    const len  = data.length;
    const mid  = h / 2;

    ctx.strokeStyle = '#5cbf5c';
    ctx.lineWidth   = 1;
    ctx.beginPath();

    for (let x = 0; x < w; x++) {
        const offset = Math.floor(x * len / w);
        const step   = Math.max(1, Math.floor(len / w));
        let min = 1, max = -1;
        for (let j = 0; j < step && (offset + j) < len; j++) {
            // Quantize to 8-bit signed range (-128..127)
            const raw = data[offset + j];
            const q   = Math.round(Math.max(-1, Math.min(1, raw)) * 127) / 127;
            if (q < min) min = q;
            if (q > max) max = q;
        }
        const y1 = mid - max * mid;
        const y2 = mid - min * mid;
        ctx.moveTo(x + 0.5, y1);
        ctx.lineTo(x + 0.5, y2);
    }
    ctx.stroke();

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
}

function _sndRenderPreviews() {
    const wfCanvas  = document.getElementById('snd-canvas-waveform');
    const cvCanvas  = document.getElementById('snd-canvas-converted');

    // Size canvases to fill container
    const rect = wfCanvas.parentElement.getBoundingClientRect();
    const w = Math.max(rect.width - 2, 200);   // -2 for border
    wfCanvas.width  = w;  wfCanvas.height = 120;
    cvCanvas.width  = w;  cvCanvas.height = 120;

    _sndDrawWaveform(wfCanvas, _sndAudioBuffer);
    _sndDrawConverted(cvCanvas, _sndAudioBuffer);
}

// ── Open sound file ──────────────────────────────────────────────────────

async function sndOpenFile(relativePath, projectDir) {
    _sndProjectDir = projectDir;
    const name       = relativePath.replace(/\\/g, '/').split('/').pop();
    const normalized = relativePath.replace(/\\/g, '/');
    const slashIdx   = normalized.lastIndexOf('/');
    _sndSourceDir    = slashIdx >= 0 ? normalized.slice(0, slashIdx) : '';
    _sndSourceName   = name;

    const statusEl = document.getElementById('snd-status');
    statusEl.textContent = `Loading ${name}\u2026`;

    try {
        const bytes = await window.electronAPI.readAsset({ projectDir, path: relativePath });
        const buf   = new Uint8Array(bytes);
        const ext   = name.split('.').pop().toLowerCase();
        const mime  = {
            wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg',
            aiff: 'audio/aiff', '8svx': 'audio/x-8svx'
        }[ext] || 'audio/wav';

        // Decode via Web Audio API
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const decoded  = await audioCtx.decodeAudioData(arrayBuf);
        audioCtx.close();

        _sndAudioBuffer = decoded;
        _sndFilename    = name.replace(/\.[^.]+$/, '') + '.sraw';

        // Show workspace
        document.getElementById('snd-placeholder').style.display = 'none';
        document.getElementById('snd-workspace').style.display   = '';

        // Properties
        const period    = parseInt(document.getElementById('snd-rng-period').value);
        const targetHz  = _sndPeriodToHz(period);
        const outSamples = Math.round(decoded.duration * targetHz);
        const chipBytes  = outSamples;  // 8-bit = 1 byte per sample

        document.getElementById('snd-prop-file').textContent     = name;
        document.getElementById('snd-prop-duration').textContent  = _sndFormatDuration(decoded.duration);
        document.getElementById('snd-prop-rate').textContent      = `${decoded.sampleRate} Hz`;
        document.getElementById('snd-prop-channels').textContent  = decoded.numberOfChannels === 1 ? 'Mono' : 'Stereo';
        document.getElementById('snd-prop-samples').textContent   = `${outSamples.toLocaleString()} @ ${targetHz} Hz`;

        document.getElementById('snd-prop-chip').textContent = `${(chipBytes / 1024).toFixed(1)} KB`;
        document.getElementById('snd-prop-pct').textContent  = `${(chipBytes / (512 * 1024) * 100).toFixed(2)}%`;

        document.getElementById('snd-btn-convert').disabled   = false;
        document.getElementById('snd-btn-copy-code').disabled  = false;

        statusEl.textContent = `${name} \u2014 ${_sndFormatDuration(decoded.duration)}, ${decoded.sampleRate} Hz, ${decoded.numberOfChannels}ch`;

        _sndRenderPreviews();

        if (window.logLine) window.logLine(`[Sound] Opened ${name} (${_sndFormatDuration(decoded.duration)}, ${decoded.sampleRate} Hz)`, 'info');
    } catch (err) {
        statusEl.textContent = `Error loading ${name}`;
        if (window.logLine) window.logLine(`[Sound] Error: '${name}' \u2014 ${err.message}`, 'error');
    }
}

window.sndOpenFile = sndOpenFile;

// ── Period slider ─────────────────────────────────────────────────────────

function _sndUpdatePeriod() {
    const period = parseInt(document.getElementById('snd-rng-period').value);
    const hz     = _sndPeriodToHz(period);
    document.getElementById('snd-period-display').innerHTML = `${period} &asymp; ${hz.toLocaleString()} Hz`;

    // Update budget if a file is loaded
    if (_sndAudioBuffer) {
        const outSamples = Math.round(_sndAudioBuffer.duration * hz);
        const chipBytes  = outSamples;
        document.getElementById('snd-prop-samples').textContent = `${outSamples.toLocaleString()} @ ${hz} Hz`;
        document.getElementById('snd-prop-chip').textContent     = `${(chipBytes / 1024).toFixed(1)} KB`;
        document.getElementById('snd-prop-pct').textContent      = `${(chipBytes / (512 * 1024) * 100).toFixed(2)}%`;
    }
}

// ── Convert & Save (.sraw — 8-bit signed PCM) ────────────────────────────

async function _sndConvertAndSave() {
    if (!_sndAudioBuffer) return;
    const btn = document.getElementById('snd-btn-convert');
    btn.disabled    = true;
    btn.textContent = 'Converting\u2026';

    try {
        const period   = parseInt(document.getElementById('snd-rng-period').value);
        const targetHz = _sndPeriodToHz(period);

        // Mix to mono
        const srcData = _sndAudioBuffer.getChannelData(0);
        const srcRate = _sndAudioBuffer.sampleRate;

        // Resample to target rate (linear interpolation)
        const outLen = Math.round(_sndAudioBuffer.duration * targetHz);
        const out    = new Int8Array(outLen);
        const ratio  = srcRate / targetHz;

        for (let i = 0; i < outLen; i++) {
            const srcPos = i * ratio;
            const idx    = Math.floor(srcPos);
            const frac   = srcPos - idx;
            const s0     = idx < srcData.length ? srcData[idx] : 0;
            const s1     = (idx + 1) < srcData.length ? srcData[idx + 1] : s0;
            const sample = s0 + (s1 - s0) * frac;
            out[i] = Math.max(-128, Math.min(127, Math.round(sample * 127)));
        }

        const defaultPath = [
            _sndProjectDir ? _sndProjectDir.replace(/\\/g, '/') : null,
            _sndSourceDir || null,
            _sndFilename,
        ].filter(Boolean).join('/');

        const result = await window.electronAPI.saveAssetWithDialog({
            defaultPath,
            filters: [{ name: 'Amiga Raw Sound', extensions: ['sraw'] }],
            data: Array.from(new Uint8Array(out.buffer)),
        });

        if (!result.saved) { btn.disabled = false; btn.textContent = 'Convert & Save'; return; }

        btn.textContent = 'Saved!';
        if (window.logLine) {
            window.logLine(`[Sound] Converted ${_sndFilename} (${outLen.toLocaleString()} samples, ${(outLen / 1024).toFixed(1)} KB, period ${period})`, 'info');
        }
        setTimeout(() => { btn.textContent = 'Convert & Save'; btn.disabled = false; }, 1500);
    } catch (err) {
        btn.textContent = 'Error!';
        if (window.logLine) window.logLine(`[Sound] Save failed: '${_sndFilename}' \u2014 ${err.message}`, 'error');
        setTimeout(() => { btn.textContent = 'Convert & Save'; btn.disabled = false; }, 2000);
    }
}

// ── Copy Code ─────────────────────────────────────────────────────────────

function _sndCopyCode() {
    if (!_sndAudioBuffer) return;
    const code = `LoadSound 0, "${_sndFilename}"`;
    navigator.clipboard.writeText(code).catch(() => {});
    const btn = document.getElementById('snd-btn-copy-code');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy Code'; }, 1200);
}

// ── Event wiring ──────────────────────────────────────────────────────────

document.getElementById('snd-rng-period').addEventListener('input', _sndUpdatePeriod);
document.getElementById('snd-btn-convert').addEventListener('click', _sndConvertAndSave);
document.getElementById('snd-btn-copy-code').addEventListener('click', _sndCopyCode);
