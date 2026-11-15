import {
  PlatformAccessory,
  Service,
  CameraController,
  CameraControllerOptions,
  SRTPCryptoSuites,
  H264Profile,
  H264Level,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
} from 'homebridge';
import type { BoschEyesPlatform } from './platform';
import { StreamingDelegate } from './streamingDelegate';
import type { SessionManager } from './sessionManager';
import type { CameraOverride } from './settings';
import type { BoschCamera } from './boschApi';

export class BoschEyesCameraAccessory {
  private readonly motionService: Service;

  constructor(
    private readonly platform: BoschEyesPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly sessionManager: SessionManager,
    camera: BoschCamera,
    override?: CameraOverride,
  ) {
    const name = override?.name ?? camera.title;
    const maxStreams = override?.maxStreams ?? 2;
    const maxWidth = override?.maxWidth ?? 1280;
    const maxHeight = override?.maxHeight ?? 720;
    const maxFPS = override?.maxFPS ?? 15;

    this.accessory
      .getService(this.platform.api.hap.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.api.hap.Characteristic.Manufacturer, 'Bosch')
      .setCharacteristic(this.platform.api.hap.Characteristic.Model, `Eyes ${camera.hardwareVersion ?? 'Camera'}`)
      .setCharacteristic(this.platform.api.hap.Characteristic.SerialNumber, camera.macAddress ?? camera.id)
      .setCharacteristic(this.platform.api.hap.Characteristic.FirmwareRevision, camera.firmwareVersion ?? 'unknown');

    // Motion sensor placeholder — Bosch handles real alerts via its own push service
    this.motionService =
      this.accessory.getService(this.platform.api.hap.Service.MotionSensor) ??
      this.accessory.addService(this.platform.api.hap.Service.MotionSensor, `${name} Motion`);
    this.motionService
      .getCharacteristic(this.platform.api.hap.Characteristic.MotionDetected)
      .onGet(() => false);

    const delegate = new StreamingDelegate(
      this.platform.api.hap,
      this.platform.log,
      name,
      sessionManager,
      this.platform.config.ffmpegPath ?? 'ffmpeg',
      this.platform.config.debugStreaming ?? false,
    );

    const options: CameraControllerOptions = {
      cameraStreamCount: maxStreams,
      delegate,
      streamingOptions: {
        supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [320, 180, 30],
            [320, 240, 15],
            [480, 270, 30],
            [480, 360, 15],
            [640, 360, 30],
            [640, 480, 15],
            [1280, 720, 30],
            [1920, 1080, 15],
            [maxWidth, maxHeight, maxFPS],
          ],
          codec: {
            profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
            levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
          },
        },
        audio: {
          twoWayAudio: false,
          codecs: [
            {
              type: AudioStreamingCodecType.AAC_ELD,
              samplerate: AudioStreamingSamplerate.KHZ_16,
            },
          ],
        },
      },
    };

    const cameraController = new this.platform.api.hap.CameraController(options);
    delegate.controller = cameraController;
    this.accessory.configureController(cameraController);

    this.platform.log.info(`[${name}] Camera accessory configured (Bosch ID: ${camera.id})`);
  }
}
