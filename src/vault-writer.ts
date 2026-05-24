import { Vault, normalizePath } from 'obsidian';
import { XhsNote, SYNC_TARGET_FOLDERS } from './types';

const FOLDER_MAP: Record<string, string> = { ...SYNC_TARGET_FOLDERS, search: 'Search' };
import { log, logError } from './logger';

function formatDate(ts: number): string {
  if (!ts) return '';
  return new Date(ts).toISOString();
}

function nowString(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, '_').trim().slice(0, 80) || 'untitled';
}

function yamlStr(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[${v.map(i => JSON.stringify(i)).join(', ')}]`;
  }
  return String(v);
}

export class VaultWriter {
  constructor(
    private vault: Vault,
    private rootFolder: string,
    private syncTags: boolean,
    private fetchBinary: (url: string) => Promise<ArrayBuffer>,
  ) {}

  async write(note: XhsNote, target: string, category?: string): Promise<void> {
    const folder = FOLDER_MAP[target] ?? target;
    const subDir = category ? `${folder}/${sanitize(category)}` : folder;
    const noteDir = normalizePath(`${this.rootFolder}/${subDir}`);
    const mediaDir = normalizePath(`${this.rootFolder}/Media`);

    // 每篇笔记独立媒体子目录，用笔记文件名命名（与 md 文件同名）
    const title = note.title || note.desc.slice(0, 40) || note.id;
    const fileName = sanitize(title);
    const noteMediaDir = normalizePath(`${mediaDir}/${fileName}`);

    await this.ensureDir(noteDir);
    await this.ensureDir(mediaDir);
    await this.ensureDir(noteMediaDir);

    // 相对路径前缀：subDir 有几段就需要往上几层才能到达 rootFolder/Media/
    const relPrefix = '../'.repeat(subDir.split('/').length);

    // 下载视频（视频帖）
    let localVideo = '';
    if (note.type === 'video' && note.videoUrl) {
      try {
        const safeUrl = note.videoUrl.replace(/^http:\/\//i, 'https://');
        const videoPath = normalizePath(`${noteMediaDir}/${fileName}.mp4`);
        if (!await this.vault.adapter.exists(videoPath)) {
          log(`[VaultWriter] downloading video: ${safeUrl}`);
          const buf = await this.fetchBinary(safeUrl);
          await this.vault.adapter.writeBinary(videoPath, buf);
        }
        localVideo = `${relPrefix}Media/${fileName}/${fileName}.mp4`;
      } catch (e: any) {
        logError('[VaultWriter] video download failed:', e.message);
      }
    }

    // 下载图片（普通帖全部图片；视频帖无视频时下载封面）
    const localImages: string[] = [];
    for (let i = 0; i < note.imageList.length; i++) {
      if (note.type === 'video' && localVideo) break; // 视频下载成功则跳过封面
      const imgUrl = note.imageList[i].url;
      if (!imgUrl) continue;
      try {
        const ext = this.guessExt(imgUrl);
        const imgName = `${i + 1}${ext}`;
        const imgPath = normalizePath(`${noteMediaDir}/${imgName}`);
        if (!await this.vault.adapter.exists(imgPath)) {
          log(`[VaultWriter] downloading image: ${imgUrl}`);
          const buf = await this.fetchBinary(imgUrl);
          await this.vault.adapter.writeBinary(imgPath, buf);
        }
        localImages.push(`${relPrefix}Media/${fileName}/${imgName}`);
      } catch (e: any) {
        logError(`[VaultWriter] image download failed (${imgUrl}):`, e.message);
      }
    }

    const tags = this.syncTags
      ? note.tagList.map(t => t.name).filter(Boolean)
      : [];

    const filePath = normalizePath(`${noteDir}/${fileName}.md`);

    const frontmatter = [
      '---',
      `id: ${yamlStr(note.id)}`,
      `title: ${yamlStr(title)}`,
      `author: ${yamlStr(note.author.nickname)}`,
      `type: ${yamlStr(target)}`,
      `url: ${yamlStr(`https://www.xiaohongshu.com/explore/${note.id}?xsec_token=${encodeURIComponent(note.xsecToken)}&xsec_source=pc_feed`)}`,
      tags.length ? `tags: ${yamlStr(tags)}` : `tags: []`,
      ...(category ? [`category: ${yamlStr(category)}`] : []),
      `createdAt: ${yamlStr(formatDate(note.time))}`,
      `syncedAt: ${yamlStr(nowString())}`,
      `likes: ${note.interactInfo.likedCount}`,
      `comments: ${note.interactInfo.commentCount}`,
      '---',
    ].join('\n');

    const mediaLines = localVideo
      ? `![](${localVideo})`
      : localImages.map(p => `![](${p})`).join('\n\n');

    const body = [
      note.desc.trim(),
      mediaLines,
    ].filter(Boolean).join('\n\n');

    const content = `${frontmatter}\n\n${body}\n`;

    if (await this.vault.adapter.exists(filePath)) {
      const existing = await this.vault.adapter.read(filePath);
      // 只有内容变化才覆写，避免触发不必要的 Obsidian 重索引
      if (existing !== content) {
        await this.vault.adapter.write(filePath, content);
      }
    } else {
      await this.vault.create(filePath, content);
    }
  }

  private async ensureDir(path: string): Promise<void> {
    if (!await this.vault.adapter.exists(path)) {
      await this.vault.createFolder(path);
    }
  }

  private guessExt(url: string): string {
    const u = url.split('?')[0].toLowerCase();
    if (u.endsWith('.png')) return '.png';
    if (u.endsWith('.webp')) return '.webp';
    if (u.endsWith('.gif')) return '.gif';
    return '.jpg';
  }
}
