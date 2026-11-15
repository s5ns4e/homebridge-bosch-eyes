import {
  CameraController,
  CameraStreamingDelegate,
  HAP,
  Logger,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  SRTPCryptoSuites,
  StreamingRequest,
  StreamRequestCallback,
  StreamRequestTypes,
  StreamSessionIdentifier,
  VideoInfo,
} from 'homebridge';
import { ChildProcess, spawn } from 'child_process';
import type { SessionManager } from './sessionManager';

interface SessionData {
  targetAddress: string;
  videoPort: number;
  videoSRTPKey: Buffer;
  videoSRTPSalt: Buffer;
  audioPort: number;
  audioSRTPKey: Buffer;
  audioSRTPSalt: Buffer;
  videoSSRC: number;
  audioSSRC: number;
}

interface ActiveSession {
  sessionData: SessionData;
  ffmpegProcess?: ChildProcess;
  startTimeout?: NodeJS.Timeout;
}

export class StreamingDelegate implements CameraStreamingDelegate {
  private readonly pendingSessions = new Map<StreamSessionIdentifier, SessionData>();
  private readonly activeSessions = new Map<StreamSessionIdentifier, ActiveSession>();

  controller!: CameraController;

  constructor(
    private readonly hap: HAP,
    private readonly log: Logger,
    private readonly cameraName: string,
    private readonly sessionManager: SessionManager,
    private readonly ffmpegPath: string,
    private readonly debug: boolean,
  ) {}

  async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
    let rtspUrl: string;
    try {
      const session = await this.sessionManager.ensureSession();
      rtspUrl = this.sessionManager.getRtspUrl(session);
    } catch (err) {
      this.log.error(`[${this.cameraName}] Snapshot: cannot open session:`, (err as Error).message);
      callback(err as Error);
      return;
    }

    const args = [
      '-loglevel', this.debug ? 'verbose' : 'error',
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-frames:v', '1',
      '-vf', `scale=${request.width}:${request.height}`,
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ];

    this.log.debug(`[${this.cameraName}] Snapshot: ${this.ffmpegPath} ${args.join(' ')}`);

    const ff = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];

    ff.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ff.stderr.on('data', (data: Buffer) => {
      if (this.debug) this.log.debug(`[${this.cameraName}] snapshot ffmpeg:`, data.toString().trim());
    });

    ff.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        callback(undefined, Buffer.concat(chunks));
      } else {
        this.log.error(`[${this.cameraName}] Snapshot ffmpeg exited with code ${code}`);
        callback(new Error(`ffmpeg snapshot failed (exit ${code})`));
      }
    });
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    this.log.info(`[${this.cameraName}] prepareStream called from ${request.targetAddress}`);
    const videoSSRC = this.randomInt32();
    const audioSSRC = this.randomInt32();

    const sessionData: SessionData = {
      targetAddress: request.targetAddress,
      videoPort: request.video.port,
      videoSRTPKey: request.video.srtp_key,
      videoSRTPSalt: request.video.srtp_salt,
      audioPort: request.audio.port,
      audioSRTPKey: request.audio.srtp_key,
      audioSRTPSalt: request.audio.srtp_salt,
      videoSSRC,
      audioSSRC,
    };

    this.pendingSessions.set(request.sessionID, sessionData);

    const response: PrepareStreamResponse = {
      video: {
        port: request.video.port,
        ssrc: videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
      audio: {
        port: request.audio.port,
        ssrc: audioSSRC,
        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      },
    };

    callback(undefined, response);
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START: {
        this.log.info(`[${this.cameraName}] handleStreamRequest START`);
        const sessionData = this.pendingSessions.get(request.sessionID);
        if (!sessionData) {
          this.log.error(`[${this.cameraName}] No pending session for`, request.sessionID);
          callback(new Error('Unknown session'));
          return;
        }
        this.pendingSessions.delete(request.sessionID);
        this.startStream(request.sessionID, sessionData, request.video, callback);
        break;
      }
      case StreamRequestTypes.RECONFIGURE:
        this.log.debug(`[${this.cameraName}] Reconfigure (ignored):`, request.sessionID);
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  private startStream(
    sessionId: StreamSessionIdentifier,
    session: SessionData,
    video: VideoInfo,
    callback: StreamRequestCallback,
  ): void {
    // Open (or reuse) the Bosch live session to get the RTSP URL via TLS proxy
    this.sessionManager.ensureSession().then((liveSession) => {
      const rtspUrl = this.sessionManager.getRtspUrl(liveSession);
      const srtpParams = Buffer.concat([session.videoSRTPKey, session.videoSRTPSalt]).toString('base64');
      const target = `srtp://${session.targetAddress}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=1316`;

      const args = [
        '-loglevel', this.debug ? 'verbose' : 'error',
        '-rtsp_transport', 'tcp',
        '-i', rtspUrl,
        '-an',
        '-map', '0:v:0',
        '-vcodec', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'main',
        '-level:v', '3.1',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-b:v', `${video.max_bit_rate}k`,
        '-bufsize', `${2 * video.max_bit_rate}k`,
        '-maxrate', `${video.max_bit_rate}k`,
        '-filter:v', `fps=${video.fps},scale=${video.width}:${video.height}`,
        '-payload_type', '99',
        '-ssrc', String(session.videoSSRC),
        '-f', 'rtp',
        '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params', srtpParams,
        target,
      ];

      this.log.info(`[${this.cameraName}] Starting ffmpeg stream to ${session.targetAddress}:${session.videoPort}`);

      const ff = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const active: ActiveSession = { sessionData: session, ffmpegProcess: ff };
      this.activeSessions.set(sessionId, active);

      let fired = false;
      const fireCallback = (err?: Error) => {
        if (!fired) {
          fired = true;
          clearTimeout(active.startTimeout);
          callback(err);
        }
      };

      ff.stderr.on('data', (data: Buffer) => {
        if (this.debug) this.log.debug(`[${this.cameraName}] ffmpeg:`, data.toString().trim());
        fireCallback();
      });

      ff.on('close', (code) => {
        this.log.debug(`[${this.cameraName}] ffmpeg closed, code=${code}`);
        if (!fired) fireCallback(new Error(`ffmpeg exited immediately (code ${code})`));
        this.activeSessions.delete(sessionId);
      });

      // Safety timeout: if ffmpeg emits no stderr within 5s assume it's running
      active.startTimeout = setTimeout(() => fireCallback(), 5000);
    }).catch((err: Error) => {
      this.log.error(`[${this.cameraName}] Stream: cannot open session:`, err.message);
      callback(err);
    });
  }

  private stopStream(sessionId: StreamSessionIdentifier): void {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;
    clearTimeout(active.startTimeout);
    active.ffmpegProcess?.kill('SIGTERM');
    this.activeSessions.delete(sessionId);
    this.log.debug(`[${this.cameraName}] Stream stopped:`, sessionId);
  }

  private randomInt32(): number {
    return Math.floor(Math.random() * 0xffffffff);
  }
}
