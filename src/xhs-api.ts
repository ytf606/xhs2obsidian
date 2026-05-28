import { requestUrl } from 'obsidian';
import { SignManager } from './sign-manager';
import { FetchResult, XhsNote, XhsAuthor, XhsImageItem, XhsTagItem, XhsUserProfile, XhsComment, SearchSort, SearchNoteType, SearchTimeFilter, SearchRangeFilter, SearchPosFilter } from './types';
import { log, logError } from './logger';

function base36Encode(num: bigint): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  if (num === 0n) return '0';
  let result = '';
  let n = num;
  while (n > 0n) { result = alphabet[Number(n % 36n)] + result; n = n / 36n; }
  return result;
}

function generateSearchId(): string {
  const e = BigInt(Date.now()) << 64n;
  const t = BigInt(Math.floor(Math.random() * 2147483646));
  return base36Encode(e + t);
}

const API_BASE = 'https://edith.xiaohongshu.com';
const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'Origin': 'https://www.xiaohongshu.com',
  'Referer': 'https://www.xiaohongshu.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
};

// Parses either a list NoteInfo item or a detail NoteCard into XhsNote.
// List items have: note_id, display_title, user.nick_name, cover, xsec_token (no desc/image_list/tag_list)
// Detail items have: note_id, title, desc, image_list, tag_list, time, user.nickname
function toNote(raw: any): XhsNote | null {
  try {
    const userRaw = raw.user ?? {};
    const interactInfo = raw.interact_info ?? {};
    const author: XhsAuthor = {
      userId: userRaw.user_id ?? '',
      nickname: userRaw.nickname ?? userRaw.nick_name ?? '未知',
      avatar: userRaw.avatar ?? userRaw.images ?? '',
    };
    const imageList: XhsImageItem[] = (raw.image_list ?? []).map((img: any) => ({
      url: img.url_default ?? img.url ?? '',
    })).filter((img: XhsImageItem) => img.url);
    // Fallback to cover when list items have no image_list (search API only returns cover)
    if (imageList.length === 0 && raw.cover) {
      const coverUrl = raw.cover.url_default ?? raw.cover.url ?? '';
      if (coverUrl) imageList.push({ url: coverUrl });
    }

    const tagList: XhsTagItem[] = (raw.tag_list ?? []).map((tag: any) => ({
      id: tag.id ?? '',
      name: tag.name ?? '',
      type: tag.type ?? '',
    }));

    // Extract best-quality video URL for video-type notes
    let videoUrl = '';
    if (raw.type === 'video') {
      const stream = raw.video?.media?.stream ?? {};
      const tracks: any[] = stream.h265 ?? stream.h_265 ?? stream.h264 ?? stream.h_264 ?? [];
      if (tracks.length > 0) {
        const best = [...tracks].sort((a: any, b: any) => (b.size ?? 0) - (a.size ?? 0))[0];
        videoUrl = best.master_url ?? '';
      }
    }

    return {
      id: raw.note_id ?? raw.id ?? '',
      title: raw.title ?? raw.display_title ?? '',
      desc: raw.desc ?? '',
      type: raw.type ?? 'normal',
      author,
      imageList,
      tagList,
      interactInfo: {
        likedCount: interactInfo.liked_count ?? interactInfo.likedCount ?? '0',
        commentCount: interactInfo.comment_count ?? interactInfo.commentCount ?? '0',
        shareCount: interactInfo.share_count ?? interactInfo.shareCount ?? '0',
      },
      time: raw.time ?? 0,
      xsecToken: raw.xsec_token ?? '',
      videoUrl,
    };
  } catch {
    return null;
  }
}

function toComment(raw: any): XhsComment | null {
  try {
    const userRaw = raw.user_info ?? raw.userInfo ?? {};
    return {
      id: raw.id ?? '',
      content: raw.content ?? '',
      createTime: raw.create_time ?? raw.createTime ?? 0,
      likeCount: String(raw.like_count ?? raw.likeCount ?? '0'),
      ipLocation: raw.ip_location ?? raw.ipLocation ?? '',
      userInfo: {
        userId: userRaw.user_id ?? userRaw.userId ?? '',
        nickname: userRaw.nickname ?? '',
        avatar: userRaw.avatar ?? userRaw.images ?? '',
      },
      subCommentCount: parseInt(raw.sub_comment_count ?? raw.subCommentCount ?? '0') || 0,
      subComments: (raw.sub_comments ?? raw.subComments ?? [])
        .map(toComment)
        .filter((c: XhsComment | null): c is XhsComment => c !== null),
    };
  } catch {
    return null;
  }
}

export class XhsApi {
  private lastRequestTime = 0;
  private static readonly MIN_INTERVAL_MS = 30_000; // 30 s global floor

  constructor(
    private sign: SignManager,
    private getCookies: () => string,
    private getUserId: () => string,
  ) {}

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (this.lastRequestTime > 0 && elapsed < XhsApi.MIN_INTERVAL_MS) {
      const wait = XhsApi.MIN_INTERVAL_MS - elapsed;
      log(`[XhsApi] rate-limit: waiting ${Math.round(wait / 1000)}s`);
      await new Promise<void>(r => setTimeout(r, wait));
    }
    this.lastRequestTime = Date.now();
  }

  private async signedGet(
    path: string,
    params: { userId: string; num: number; cursor?: string | null },
  ): Promise<any> {
    if (!this.getCookies()) throw new Error('未登录，请先登录小红书');
    // Build query string manually to preserve literal commas in image_formats.
    // Order matches rednote2obsidian: cursor?, num, user_id, image_formats, xsec_token, xsec_source
    const parts: string[] = [];
    if (params.cursor) parts.push(`cursor=${encodeURIComponent(params.cursor)}`);
    parts.push(`num=${params.num}`);
    parts.push(`user_id=${encodeURIComponent(params.userId)}`);
    parts.push('image_formats=jpg,webp,avif');
    parts.push('xsec_token=');
    parts.push('xsec_source=');
    const queryString = parts.join('&');
    const signPath = `${path}?${queryString}`;
    const fetchUrl = `${API_BASE}${signPath}`;
    log(`[RedbookPull] GET ${signPath}`);
    return this.sign.request(signPath, fetchUrl, 'GET', undefined, this.getCookies());
  }

  async getMe(): Promise<{ userId: string; nickname: string }> {
    await this.throttle();
    const cookies = this.getCookies();
    if (!cookies) throw new Error('未登录，请先登录小红书');

    const resp = await requestUrl({
      url: `${API_BASE}/api/sns/web/v2/user/me`,
      method: 'GET',
      headers: { ...COMMON_HEADERS, Cookie: cookies },
      throw: false,
    });
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
    const data = resp.json;
    log('[RedbookPull] getMe response', JSON.stringify(data).slice(0, 500));
    const info = data?.data;
    if (!info || !info.user_id) throw new Error('获取用户信息失败');
    return {
      userId: info.user_id,
      nickname: info.nickname ?? '',
    };
  }

  async fetchPosts(userId: string, cursor: string | null, num: number): Promise<FetchResult> {
    await this.throttle();
    const data = await this.signedGet('/api/sns/web/v1/user_posted', { userId, num, cursor });
    const list: any[] = (data as any)?.notes ?? (data as any)?.items ?? [];
    const items = list.map(toNote).filter((n): n is XhsNote => n !== null && !!n.id);
    return {
      items,
      cursor: (data as any)?.cursor ?? null,
      hasMore: !!((data as any)?.has_more ?? (data as any)?.hasMore),
    };
  }

  async fetchBookmarks(cursor: string | null, num: number): Promise<FetchResult> {
    await this.throttle();
    const data = await this.signedGet('/api/sns/web/v2/note/collect/page', { userId: this.getUserId(), num, cursor });
    const list: any[] = (data as any)?.notes ?? (data as any)?.items ?? [];
    const items = list.map(toNote).filter((n): n is XhsNote => n !== null && !!n.id);
    return {
      items,
      cursor: (data as any)?.cursor ?? null,
      hasMore: !!((data as any)?.has_more ?? (data as any)?.hasMore),
    };
  }

  async fetchLikes(cursor: string | null, num: number): Promise<FetchResult> {
    await this.throttle();
    const data = await this.signedGet('/api/sns/web/v1/note/like/page', { userId: this.getUserId(), num, cursor });
    const list: any[] = (data as any)?.notes ?? (data as any)?.items ?? [];
    const items = list.map(toNote).filter((n): n is XhsNote => n !== null && !!n.id);
    return {
      items,
      cursor: (data as any)?.cursor ?? null,
      hasMore: !!((data as any)?.has_more ?? (data as any)?.hasMore),
    };
  }

  async searchNotes(
    keyword: string,
    page: number,
    sort: SearchSort,
    noteType: SearchNoteType = '不限',
    timeFilter: SearchTimeFilter = '不限',
    rangeFilter: SearchRangeFilter = '不限',
    posFilter: SearchPosFilter = '不限',
  ): Promise<FetchResult> {
    const NOTE_TYPE_MAP: Record<SearchNoteType, 0 | 1 | 2> = { '不限': 0, '视频': 1, '图文': 2 };
    const path = '/api/sns/web/v1/search/notes';
    const fetchUrl = `${API_BASE}${path}`;
    const body = {
      keyword,
      page,
      page_size: 20,
      search_id: generateSearchId(),
      sort,
      note_type: NOTE_TYPE_MAP[noteType],
      ext_flags: [],
      filters: [
        { tags: [sort], type: 'sort_type' },
        { tags: [noteType], type: 'filter_note_type' },
        { tags: [timeFilter], type: 'filter_note_time' },
        { tags: [rangeFilter], type: 'filter_note_range' },
        { tags: [posFilter], type: 'filter_pos_distance' },
      ],
      geo: '',
      image_formats: ['jpg', 'webp', 'avif'],
    };
    await this.throttle();
    if (!this.getCookies()) throw new Error('未登录，请先登录小红书');
    log(`[RedbookPull] searchNotes "${keyword}" page=${page}`);
    const data = await this.sign.request(path, fetchUrl, 'POST', body, this.getCookies());
    log(`[RedbookPull] searchNotes raw data=${JSON.stringify(data).slice(0, 800)}`);
    const list: any[] = (data as any)?.items ?? [];
    const items = list.map((item: any) => {
      const card = item.note_card ?? item;
      return toNote({ ...card, id: item.id ?? card.note_id, xsec_token: item.xsec_token ?? card.xsec_token ?? '' });
    }).filter((n): n is XhsNote => n !== null && !!n.id);
    return {
      items,
      cursor: null,
      hasMore: !!(data as any)?.has_more,
    };
  }

  async fetchUserProfileAndNotes(userId: string, xsecToken = ''): Promise<{ profile: XhsUserProfile; notes: XhsNote[] }> {
    await this.throttle();
    if (!this.getCookies()) throw new Error('未登录，请先登录小红书');
    log(`[XhsApi] fetchUserProfileAndNotes via page userId=${userId}`);

    const profileUrl = xsecToken
      ? `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(userId)}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_note`
      : `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(userId)}`;

    // Extract both profile (basicInfo+interactions) and initial notes in one page load.
    // Notes are stored as a double-array [[{noteCard,...},...], ...] matching xiaohongshu-mcp user_profile.go
    const extractScript = `(() => {
      try {
        const state = window.__INITIAL_STATE__;
        if (!state?.user) return null;
        const pd = state.user.userPageData;
        const profileData = (pd?.value !== undefined ? pd.value : pd?._value) || pd?._rawValue || {};
        const nd = state.user.notes;
        const notesRaw = (nd?.value !== undefined ? nd.value : nd?._value) || [];
        const notes = [];
        for (const row of notesRaw) {
          if (!Array.isArray(row)) continue;
          for (const item of row) {
            const card = item.noteCard || item;
            notes.push({
              note_id: card.noteId || card.note_id || item.id || '',
              xsec_token: item.xsecToken || card.xsecToken || '',
              display_title: card.displayTitle || card.title || '',
              type: card.type || 'normal',
              user: card.user || {}
            });
          }
        }
        return JSON.stringify({ profileData, notes });
      } catch(e) { return null; }
    })()`;

    const raw = await this.sign.extractFromPage(profileUrl, extractScript);
    if (!raw) throw new Error('未能从页面提取用户信息，请确认已登录且账号存在');

    const parsed = JSON.parse(raw as string);
    const basic = parsed.profileData?.basicInfo ?? {};
    const interactions: any[] = parsed.profileData?.interactions ?? [];
    const getCount = (type: string) =>
      parseInt(interactions.find((i: any) => i.type === type)?.count ?? '0') || 0;

    const profile: XhsUserProfile = {
      userId,
      nickname: basic.nickname ?? '',
      avatar: basic.imageb ?? basic.images ?? '',
      desc: basic.desc ?? '',
      gender: basic.gender ?? 0,
      location: basic.ipLocation ?? basic.ip_location ?? '',
      follows: getCount('follows'),
      fans: getCount('fans'),
      interaction: getCount('interaction'),
      noteCount: 0,
      fetchedAt: new Date().toISOString(),
    };

    const notes = (parsed.notes ?? [])
      .map((n: any) => toNote(n))
      .filter((n: XhsNote | null): n is XhsNote => n !== null && !!n.id);

    return { profile, notes };
  }

  async fetchNoteDetail(noteId: string, xsecToken: string): Promise<XhsNote | null> {
    await this.throttle();
    const path = '/api/sns/web/v1/feed';
    const fetchUrl = `${API_BASE}${path}`;
    const body = {
      source_note_id: noteId,
      image_formats: ['jpg', 'webp', 'avif'],
      extra: { need_body_topic: '1' },
      xsec_source: 'pc_feed',
      xsec_token: xsecToken,
    };
    log(`[RedbookPull] fetchNoteDetail ${noteId}`);
    const data = await this.sign.request(path, fetchUrl, 'POST', body, this.getCookies());
    const item = (data as any)?.items?.[0];
    if (!item) return null;
    const card = item.note_card ?? item;
    return toNote({ ...card, xsec_token: xsecToken });
  }

  async fetchComments(noteId: string, cursor: string, xsecToken: string): Promise<{ comments: XhsComment[]; cursor: string; hasMore: boolean }> {
    await this.throttle();
    if (!this.getCookies()) throw new Error('未登录，请先登录小红书');
    const parts: string[] = [];
    parts.push(`note_id=${encodeURIComponent(noteId)}`);
    if (cursor) parts.push(`cursor=${encodeURIComponent(cursor)}`);
    parts.push('image_formats=jpg,webp,avif');
    if (xsecToken) parts.push(`xsec_token=${encodeURIComponent(xsecToken)}`);
    const path = '/api/sns/web/v2/comment/page';
    const signPath = `${path}?${parts.join('&')}`;
    const fetchUrl = `${API_BASE}${signPath}`;
    log(`[RedbookPull] fetchComments ${noteId} cursor=${cursor}`);
    const data = await this.sign.request(signPath, fetchUrl, 'GET', undefined, this.getCookies());
    const list: any[] = (data as any)?.comments ?? [];
    const comments = list.map(toComment).filter((c): c is XhsComment => c !== null);
    return {
      comments,
      cursor: (data as any)?.cursor ?? '',
      hasMore: !!((data as any)?.has_more ?? (data as any)?.hasMore),
    };
  }

  async fetchSubComments(noteId: string, rootCommentId: string, cursor: string): Promise<{ comments: XhsComment[]; cursor: string; hasMore: boolean }> {
    await this.throttle();
    if (!this.getCookies()) throw new Error('未登录，请先登录小红书');
    const parts: string[] = [];
    parts.push(`note_id=${encodeURIComponent(noteId)}`);
    parts.push(`root_comment_id=${encodeURIComponent(rootCommentId)}`);
    parts.push('num=30');
    if (cursor) parts.push(`cursor=${encodeURIComponent(cursor)}`);
    const path = '/api/sns/web/v2/comment/sub/page';
    const signPath = `${path}?${parts.join('&')}`;
    const fetchUrl = `${API_BASE}${signPath}`;
    log(`[RedbookPull] fetchSubComments note=${noteId} root=${rootCommentId}`);
    const data = await this.sign.request(signPath, fetchUrl, 'GET', undefined, this.getCookies());
    const list: any[] = (data as any)?.comments ?? [];
    const comments = list.map(toComment).filter((c): c is XhsComment => c !== null);
    return {
      comments,
      cursor: (data as any)?.cursor ?? '',
      hasMore: !!((data as any)?.has_more ?? (data as any)?.hasMore),
    };
  }
}
