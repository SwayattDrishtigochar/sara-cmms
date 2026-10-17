// no-inline: keep the worklet a real file (Vite would inline a small one as a data: URL, which a strict CSP blocks).
import workletUrl from './captureWorklet.js?url&no-inline';

/** { ok: true } | { ok: false, reason: 'insecure' | 'no-media' | 'no-worklet' | 'no-websocket' } */
export const micSupport = () => {
  if (!globalThis.isSecureContext) return { ok: false, reason: 'insecure' };
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) return { ok: false, reason: 'no-media' };
  if (typeof globalThis.AudioWorkletNode !== 'function') return { ok: false, reason: 'no-worklet' };
  if (typeof globalThis.WebSocket !== 'function') return { ok: false, reason: 'no-websocket' };
  return { ok: true };
};

const MESSAGES = {
  MIC_DENIED: 'Microphone access is blocked. Allow it in your browser’s site settings, or type instead.',
  NO_MIC: 'No microphone found. Plug one in, or type instead.',
  MIC_BUSY: 'Your microphone is busy in another app. Close that app and try again.',
  MIC_ERROR: 'The microphone could not start. Try again, or type instead.',
};

/** Browser getUserMedia / audio error → Error with a friendly message and `code` MIC_DENIED | NO_MIC | MIC_ERROR. */
export const micError = (cause) => {
  const name = cause?.name;
  const code =
    name === 'NotAllowedError' || name === 'SecurityError'
      ? 'MIC_DENIED'
      : name === 'NotFoundError' || name === 'OverconstrainedError'
        ? 'NO_MIC'
        : 'MIC_ERROR';
  const error = new Error(MESSAGES[name === 'NotReadableError' ? 'MIC_BUSY' : code], { cause });
  error.code = code;
  return error;
};

/** getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).
 *  Errors carry `code`: MIC_DENIED (NotAllowedError), NO_MIC (NotFoundError), MIC_ERROR. */
export const startMic = async ({ context, onFrame, onLevel }) => {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (cause) {
    throw micError(cause);
  }
  const tracks = stream.getAudioTracks();
  const stopTracks = () => {
    for (const track of tracks) track.stop();
  };

  let source;
  let node;
  try {
    await context.audioWorklet.addModule(workletUrl);
    source = context.createMediaStreamSource(stream);
    // Zero outputs: the node is pulled as a sink, so the mic is never routed to the speakers.
    node = new AudioWorkletNode(context, 'sara-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
  } catch (cause) {
    stopTracks();
    throw micError(cause);
  }

  let stopped = false;
  node.port.onmessage = ({ data }) => {
    if (stopped) return;
    onFrame?.(data.pcm);
    onLevel?.(data.level);
  };
  source.connect(node);

  return {
    /** Muted tracks deliver silence, so frames keep flowing and the server's VAD can still end the turn. */
    setMuted(muted) {
      for (const track of tracks) track.enabled = !muted;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      stopTracks();
    },
  };
};
