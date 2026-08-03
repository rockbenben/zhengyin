import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { slugify } from './mw.js';

export async function synthesizeTts(text: string, destDir: string): Promise<string | null> {
  try {
    mkdirSync(destDir, { recursive: true });
    const tts = new MsEdgeTTS();
    await tts.setMetadata('en-US-AriaNeural', OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const file = `${slugify(text)}-tts.mp3`;
    const { audioStream } = tts.toStream(text);
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(join(destDir, file));
      audioStream.pipe(out);
      out.on('finish', resolve);
      audioStream.on('error', reject);
      out.on('error', reject);
    });
    return file;
  } catch (e) {
    console.warn('[tts] 合成失败', e);
    return null;
  }
}
