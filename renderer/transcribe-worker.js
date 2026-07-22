'use strict';

/**
 * Whisper transcription worker — keeps the UI thread free while the model
 * runs. Receives 16 kHz mono Float32 PCM, posts back progress/result/error.
 * Model: Xenova/whisper-tiny.en (~40 MB, downloaded once from huggingface.co
 * into the browser cache, then fully offline).
 */

import { pipeline, env } from '../node_modules/@huggingface/transformers/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
// Load the ONNX WASM runtime from the locally bundled files instead of the
// default cdn.jsdelivr.net URL, which is blocked by the app's CSP.
env.backends.onnx.wasm.wasmPaths = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url).href;

let transcriber = null;
let loading = false;

async function ensureModel(id) {
  if (transcriber) return;
  if (loading) { while (loading) await new Promise(r => setTimeout(r, 200)); return; }
  loading = true;
  try {
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      progress_callback: (p) => {
        if (p && p.status === 'progress' && p.total) {
          self.postMessage({ id, type: 'progress', pct: Math.round((p.loaded / p.total) * 100) });
        }
      },
    });
    self.postMessage({ id, type: 'ready' });
  } finally {
    loading = false;
  }
}

self.onmessage = async (e) => {
  const { id, pcm } = e.data || {};
  try {
    await ensureModel(id);
    const out = await transcriber(pcm, { chunk_length_s: 30, stride_length_s: 5 });
    self.postMessage({ id, type: 'result', text: String((out && out.text) || '').trim() });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
