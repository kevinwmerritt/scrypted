
import { FFMpegInput, MotionSensor, ScryptedDevice, ScryptedMimeTypes, VideoCamera, AudioSensor, MediaStreamOptions } from '@scrypted/sdk'
import { H264Level, H264Profile } from '../../hap';

import sdk from '@scrypted/sdk';

import { AudioRecordingCodecType, AudioRecordingSamplerateValues, CameraRecordingConfiguration } from '../../../HAP-NodeJS/src/lib/camera/RecordingManagement';
import { startFFMPegFragmetedMP4Session } from '@scrypted/common/src/ffmpeg-mp4-parser-session';

const { log, mediaManager, deviceManager } = sdk;


export const iframeIntervalSeconds = 4;

export async function* handleFragmentsRequests(device: ScryptedDevice & VideoCamera & MotionSensor & AudioSensor,
    configuration: CameraRecordingConfiguration, console: Console): AsyncGenerator<Buffer, void, unknown> {

    console.log(device.name, 'recording session starting', configuration);

    const storage = deviceManager.getMixinStorage(device.id, undefined);

    let selectedStream: MediaStreamOptions;
    let recordingChannel = storage.getItem('recordingChannel');
    if (recordingChannel) {
        const msos = await device.getVideoStreamOptions();
        selectedStream = msos.find(mso => mso.name === recordingChannel);
    }

    const media = await device.getVideoStream({
        id: selectedStream?.id,
        prebuffer: configuration.mediaContainerConfiguration.prebufferLength,
        container: 'mp4',
    });
    const ffmpegInput = JSON.parse((await mediaManager.convertMediaObjectToBuffer(media, ScryptedMimeTypes.FFmpegInput)).toString()) as FFMpegInput;
    if (!ffmpegInput.mediaStreamOptions?.prebuffer) {
        log.a(`${device.name} is not prebuffered. Please install and enable the Rebroadcast plugin.`);
    }

    const transcodeRecording = storage.getItem('transcodeRecording') === 'true';

    const noAudio = ffmpegInput.mediaStreamOptions && ffmpegInput.mediaStreamOptions.audio === null;

    if (noAudio) {
        console.log(device.name, 'adding dummy audio track');
        // create a dummy audio track if none actually exists.
        // this track will only be used if no audio track is available.
        // https://stackoverflow.com/questions/37862432/ffmpeg-output-silent-audio-track-if-source-has-no-audio-or-audio-is-shorter-th
        ffmpegInput.inputArguments.push('-f', 'lavfi', '-i', 'anullsrc=cl=1', '-shortest');
    }

    let audioArgs: string[];
    if (noAudio || transcodeRecording) {
        audioArgs = [
            '-bsf:a', 'aac_adtstoasc',
            '-acodec', 'libfdk_aac',
            ...(configuration.audioCodec.type === AudioRecordingCodecType.AAC_LC ?
                ['-profile:a', 'aac_low'] :
                ['-profile:a', 'aac_eld']),
            '-ar', `${AudioRecordingSamplerateValues[configuration.audioCodec.samplerate]}k`,
            '-b:a', `${configuration.audioCodec.bitrate}k`,
            '-ac', `${configuration.audioCodec.audioChannels}`
        ];
    }
    else {
        audioArgs = [
            '-bsf:a', 'aac_adtstoasc',
            '-acodec', 'copy'
        ];
    }

    const profile = configuration.videoCodec.profile === H264Profile.HIGH ? 'high'
        : configuration.videoCodec.profile === H264Profile.MAIN ? 'main' : 'baseline';

    const level = configuration.videoCodec.level === H264Level.LEVEL4_0 ? '4.0'
        : configuration.videoCodec.level === H264Level.LEVEL3_2 ? '3.2' : '3.1';


    let videoArgs: string[];
    if (transcodeRecording) {
        videoArgs = [
            '-profile:v', profile,
            '-level:v', level,
            '-b:v', `${configuration.videoCodec.bitrate}k`,
            '-force_key_frames', `expr:gte(t,n_forced*${iframeIntervalSeconds})`,
            '-r', configuration.videoCodec.resolution[2].toString(),
            '-vf', `scale=w=${configuration.videoCodec.resolution[0]}:h=${configuration.videoCodec.resolution[1]}:force_original_aspect_ratio=1,pad=${configuration.videoCodec.resolution[0]}:${configuration.videoCodec.resolution[1]}:(ow-iw)/2:(oh-ih)/2`,
        ];
    }
    else {
        videoArgs = [
            '-vcodec', 'copy',
        ];
    }

    log.i(`${device.name} motion recording starting`);
    const session = await startFFMPegFragmetedMP4Session(ffmpegInput, audioArgs, videoArgs, console);

    log.i(`${device.name} motion recording started`);
    const { socket, cp, generator } = session;
    let pending: Buffer[] = [];
    try {
        for await (const box of generator) {
            const { header, type, data } = box;

            // every moov/moof frame designates an iframe?
            pending.push(header, data);

            if (type === 'moov' || type === 'mdat') {
                const fragment = Buffer.concat(pending);
                pending = [];
                yield fragment;
            }
            // console.log('mp4 box type', type, length);
        }
    }
    catch (e) {
        log.i(`${device.name} motion recording complete ${e}`);
    }
    finally {
        socket.destroy();
        cp.kill();
    }
}