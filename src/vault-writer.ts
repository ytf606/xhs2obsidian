import { Vault, normalizePath } from 'obsidian';
import { XhsNote, XhsUserProfile, XhsComment, SYNC_TARGET_FOLDERS } from './types';

const FOLDER_MAP: Record<string, string> = { ...SYNC_TARGET_FOLDERS, search: 'Search', user: 'Users' };
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

function profileUrl(userId: string): string {
  return `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(userId)}`;
}

function renderComments(comments: XhsComment[], avatarMap: Map<string, string> = new Map()): string {
  if (comments.length === 0) return '';
  const total = comments.reduce((n, c) => n + 1 + c.subComments.length, 0);
  const lines: string[] = [`## 评论 (${total})`, ''];

  for (const c of comments) {
    lines.push('---', '');
    const date = c.createTime ? new Date(c.createTime).toISOString().slice(0, 10) : '';
    const meta = [
      date,
      c.ipLocation,
      c.likeCount !== '0' ? `♥ ${c.likeCount}` : '',
    ].filter(Boolean).join(' · ');
    const authorLink = `[**@${c.userInfo.nickname || c.userInfo.userId}**](${profileUrl(c.userInfo.userId)})`;
    const avatarSrc = avatarMap.get(c.userInfo.userId) ?? '';
    const avatarImg = avatarSrc ? `![|40](${avatarSrc})` : '';
    lines.push(`${avatarImg} ${authorLink}${meta ? ` · ${meta}` : ''}`, '');
    if (c.content) lines.push(c.content, '');

    for (const sub of c.subComments) {
      const subDate = sub.createTime ? new Date(sub.createTime).toISOString().slice(0, 10) : '';
      const subMeta = [
        subDate,
        sub.ipLocation,
        sub.likeCount !== '0' ? `♥ ${sub.likeCount}` : '',
      ].filter(Boolean).join(' · ');
      const subAuthorLink = `[**@${sub.userInfo.nickname || sub.userInfo.userId}**](${profileUrl(sub.userInfo.userId)})`;
      const subAvatarSrc = avatarMap.get(sub.userInfo.userId) ?? '';
      const subAvatarImg = subAvatarSrc ? `![|32](${subAvatarSrc})` : '';
      lines.push(`> ${subAvatarImg} ${subAuthorLink}${subMeta ? ` · ${subMeta}` : ''}`);
      lines.push(`> `);
      if (sub.content) lines.push(`> ${sub.content}`);
      lines.push('');
    }
  }

  lines.push('---', '');
  return lines.join('\n');
}

export class VaultWriter {
  constructor(
    private vault: Vault,
    private rootFolder: string,
    private syncTags: boolean,
    private fetchBinary: (url: string) => Promise<ArrayBuffer>,
  ) {}

  async write(note: XhsNote, target: string, category?: string, comments: XhsComment[] = [], aiTags: string[] = []): Promise<void> {
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

    const xhsTags = this.syncTags
      ? note.tagList.map(t => t.name).filter(Boolean)
      : [];
    // Merge AI tags into the tags array (deduplicated), so they become Obsidian tags
    const allTags = [...xhsTags, ...aiTags.filter(t => !xhsTags.includes(t))];

    const filePath = normalizePath(`${noteDir}/${fileName}.md`);

    const frontmatter = [
      '---',
      `id: ${yamlStr(note.id)}`,
      `title: ${yamlStr(title)}`,
      `author: ${yamlStr(note.author.nickname)}`,
      `type: ${yamlStr(target)}`,
      `url: ${yamlStr(`https://www.xiaohongshu.com/explore/${note.id}?xsec_token=${encodeURIComponent(note.xsecToken)}&xsec_source=pc_feed`)}`,
      allTags.length ? `tags: ${yamlStr(allTags)}` : `tags: []`,
      ...(aiTags.length ? [`aiTags: ${yamlStr(aiTags)}`] : []),
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

    // Download comment avatars to local vault so they display despite CDN Referer restrictions
    const avatarMap = new Map<string, string>();
    if (comments.length > 0) {
      const avatarsDir = normalizePath(`${this.rootFolder}/Media/avatars`);
      await this.ensureDir(avatarsDir);
      const walkComment = async (c: XhsComment) => {
        if (c.userInfo.userId && c.userInfo.avatar && !avatarMap.has(c.userInfo.userId)) {
          const ext = this.guessExt(c.userInfo.avatar);
          const avatarFilename = `${c.userInfo.userId}${ext}`;
          const avatarVaultPath = normalizePath(`${avatarsDir}/${avatarFilename}`);
          const localRelPath = `${relPrefix}Media/avatars/${avatarFilename}`;
          avatarMap.set(c.userInfo.userId, localRelPath);
          if (!await this.vault.adapter.exists(avatarVaultPath)) {
            try {
              const buf = await this.fetchBinary(c.userInfo.avatar.replace(/^http:/i, 'https:'));
              await this.vault.adapter.writeBinary(avatarVaultPath, buf);
            } catch {
              avatarMap.delete(c.userInfo.userId);
            }
          }
        }
        for (const sub of c.subComments) await walkComment(sub);
      };
      for (const c of comments) await walkComment(c);
    }

    const commentSection = renderComments(comments, avatarMap);
    const content = `${frontmatter}\n\n${body}${commentSection ? '\n\n' + commentSection : '\n'}`;

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

  async writeUserNote(note: XhsNote, accountName: string): Promise<void> {
    await this.write(note, 'user', accountName);
  }

  async writeUserProfile(profile: XhsUserProfile): Promise<void> {
    const dir = normalizePath(`${this.rootFolder}/Users/${sanitize(profile.nickname)}`);
    await this.ensureDir(dir);
    const filePath = normalizePath(`${dir}/_profile.md`);

    const genderLabel = profile.gender === 1 ? '男' : profile.gender === 2 ? '女' : '未知';
    const content = [
      '---',
      `userId: ${yamlStr(profile.userId)}`,
      `nickname: ${yamlStr(profile.nickname)}`,
      `location: ${yamlStr(profile.location)}`,
      `follows: ${profile.follows}`,
      `fans: ${profile.fans}`,
      `interaction: ${profile.interaction}`,
      `noteCount: ${profile.noteCount}`,
      `fetchedAt: ${yamlStr(profile.fetchedAt)}`,
      '---',
      '',
      `# ${profile.nickname}`,
      '',
      ...(profile.desc ? [`${profile.desc}`, ''] : []),
      `| | |`,
      `|---|---|`,
      `| 性别 | ${genderLabel} |`,
      `| 位置 | ${profile.location || '—'} |`,
      `| 关注 | ${profile.follows} |`,
      `| 粉丝 | ${profile.fans} |`,
      `| 获赞与收藏 | ${profile.interaction} |`,
      '',
    ].join('\n');

    if (await this.vault.adapter.exists(filePath)) {
      const existing = await this.vault.adapter.read(filePath);
      if (existing !== content) await this.vault.adapter.write(filePath, content);
    } else {
      await this.vault.create(filePath, content);
    }
  }

  get root(): string {
    return this.rootFolder;
  }

  // Creates each path segment from root down so intermediate dirs always exist.
  async ensureDir(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const partial = parts.slice(0, i).join('/');
      if (!await this.vault.adapter.exists(partial)) {
        await this.vault.createFolder(partial);
      }
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
