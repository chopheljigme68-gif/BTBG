import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pool } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import { getFile, putFile } from '../../lib/storage.js';

/**
 * Transcode an uploaded video into low-data renditions (240p, 360p) plus 720p,
 * and generate a thumbnail (FR-VID-06, FR-VID-22). Runs in the background with
 * ffmpeg; the curator sees processing status on the video record.
 */
const RENDITIONS = [
  { name: '240', height: 240, vbit: '300k', abit: '48k' },
  { name: '360', height: 360, vbit: '600k', abit: '64k' },
  { name: '720', height: 720, vbit: '1800k', abit: '96k' },
];

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-500) || `${cmd} exited ${code}`))));
  });
}

export async function ffmpegAvailable() {
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

export async function transcodeVideo(videoId: string, originalKey: string) {
  await pool.query(`update videos set processing_status = 'processing', processing_error = null where id = $1`, [videoId]);
  const dir = await mkdtemp(path.join(tmpdir(), 'btbg-video-'));
  try {
    const input = path.join(dir, 'input');
    await writeFile(input, await getFile(originalKey));
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=height', '-of', 'json', input]);
    const meta = JSON.parse(probe);
    const duration = Math.round(Number(meta.format?.duration ?? 0));
    const srcHeight = Math.max(...(meta.streams ?? []).map((s: any) => Number(s.height) || 0), 0);
    if (duration > 1200) throw new Error('Videos can be at most 20 minutes long.');

    const renditions: Record<string, string> = {};
    for (const r of RENDITIONS.filter((x) => x.height <= Math.max(240, srcHeight))) {
      const out = path.join(dir, `${r.name}.mp4`);
      await run('ffmpeg', ['-y', '-i', input, '-vf', `scale=-2:${r.height}`, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', r.vbit, '-maxrate', r.vbit, '-bufsize', r.vbit,
        '-c:a', 'aac', '-b:a', r.abit, '-movflags', '+faststart', out]);
      renditions[r.name] = await putFile(`videos/${videoId}/${r.name}.mp4`, await readFile(out), 'video/mp4');
    }
    const thumb = path.join(dir, 'thumb.jpg');
    await run('ffmpeg', ['-y', '-ss', String(Math.min(3, Math.max(0, duration / 3))), '-i', input, '-frames:v', '1', '-vf', 'scale=640:-2', thumb]);
    const thumbKey = await putFile(`videos/${videoId}/thumb.jpg`, await readFile(thumb), 'image/jpeg');
    await pool.query(
      `update videos set renditions = $2, thumbnail_path = $3, duration_seconds = $4, kind = case when $4 < 90 then 'short' else 'long' end,
              processing_status = 'ready' where id = $1`,
      [videoId, JSON.stringify(renditions), thumbKey, duration]);
  } catch (err) {
    logger.error({ err, videoId }, 'video transcode failed');
    await pool.query(`update videos set processing_status = 'failed', processing_error = $2 where id = $1`, [videoId, (err as Error).message.slice(0, 500)]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
