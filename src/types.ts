export type SyncTarget = 'posts' | 'bookmarks' | 'likes';

export type SearchSort =
  | 'general'
  | 'time_descending'
  | 'popularity_descending'
  | 'comment_count_descending'
  | 'collect_count_descending';

export const SEARCH_SORT_LABELS: Record<SearchSort, string> = {
  general: '综合',
  time_descending: '最新',
  popularity_descending: '最多点赞',
  comment_count_descending: '最多评论',
  collect_count_descending: '最多收藏',
};

export type SearchNoteType = '不限' | '视频' | '图文';
export type SearchTimeFilter = '不限' | '一天内' | '一周内' | '半年内';
export type SearchRangeFilter = '不限' | '已看过' | '未看过' | '已关注';
export type SearchPosFilter = '不限' | '同城' | '附近';

export const SYNC_TARGET_LABELS: Record<SyncTarget, string> = {
  posts: '个人帖子',
  bookmarks: '收藏',
  likes: '点赞',
};

export const SYNC_TARGET_FOLDERS: Record<SyncTarget, string> = {
  posts: 'Posts',
  bookmarks: 'Bookmarks',
  likes: 'Likes',
};

export interface RedbookPullSettings {
  // 登录态
  cookies: string;
  a1Cookie: string;
  userId: string;
  userName: string;
  // 文件夹
  rootFolder: string;
  // 同步控制
  syncTarget: SyncTarget;
  syncBatchSize: number;
  autoSyncEnabled: boolean;
  syncIntervalMinutes: number;
  syncTags: boolean;
  syncAlbums: boolean;
  // AI 分类
  enableAiClassify: boolean;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  aiCategories: string[];
  // 持久化状态
  syncCursors: Record<SyncTarget, string | null>;
  syncedIds: Record<SyncTarget, string[]>;
  allSynced: Record<SyncTarget, boolean>;
  // 关键词搜索
  searchKeywords: string[];
  searchSort: SearchSort;
  searchNoteType: SearchNoteType;
  searchTimeFilter: SearchTimeFilter;
  searchRangeFilter: SearchRangeFilter;
  searchPosFilter: SearchPosFilter;
  searchBatchSize: number;
  autoSearchEnabled: boolean;
  searchIntervalMinutes: number;
  // 搜索持久化状态（key = 关键词）
  searchPages: Record<string, number>;
  searchedNoteIds: Record<string, string[]>;
  searchAllSynced: Record<string, boolean>;
  // 账号订阅
  followedAccounts: FollowedAccount[];
  followMinDelayMin: number;
  followMaxDelayMin: number;
  autoFollowEnabled: boolean;
  followIntervalMinutes: number;
}

export const DEFAULT_SETTINGS: RedbookPullSettings = {
  cookies: '',
  a1Cookie: '',
  userId: '',
  userName: '',
  rootFolder: 'RedNote',
  syncTarget: 'bookmarks',
  syncBatchSize: 5,
  autoSyncEnabled: false,
  syncIntervalMinutes: 10,
  syncTags: true,
  syncAlbums: false,
  enableAiClassify: false,
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini',
  aiCategories: [],
  syncCursors: { posts: null, bookmarks: null, likes: null },
  syncedIds: { posts: [], bookmarks: [], likes: [] },
  allSynced: { posts: false, bookmarks: false, likes: false },
  searchKeywords: [],
  searchSort: 'general',
  searchNoteType: '不限',
  searchTimeFilter: '不限',
  searchRangeFilter: '不限',
  searchPosFilter: '不限',
  searchBatchSize: 20,
  autoSearchEnabled: false,
  searchIntervalMinutes: 60,
  searchPages: {},
  searchedNoteIds: {},
  searchAllSynced: {},
  followedAccounts: [],
  followMinDelayMin: 1,
  followMaxDelayMin: 10,
  autoFollowEnabled: false,
  followIntervalMinutes: 60,
};

export interface XhsAuthor {
  userId: string;
  nickname: string;
  avatar: string;
}

export interface XhsImageItem {
  url: string;
}

export interface XhsTagItem {
  id: string;
  name: string;
  type: string;
}

export interface XhsInteractInfo {
  likedCount: string;
  commentCount: string;
  shareCount: string;
}

export interface XhsNote {
  id: string;
  title: string;
  desc: string;
  type: string;
  author: XhsAuthor;
  imageList: XhsImageItem[];
  tagList: XhsTagItem[];
  interactInfo: XhsInteractInfo;
  time: number;
  xsecToken: string;
  videoUrl: string;
}

export interface FetchResult {
  items: XhsNote[];
  cursor: string | null;
  hasMore: boolean;
}

export interface XhsUserProfile {
  userId: string;
  nickname: string;
  avatar: string;
  desc: string;
  gender: number;
  location: string;
  follows: number;
  fans: number;
  interaction: number;
  noteCount: number;
  fetchedAt: string;
}

export interface FollowedAccount {
  userId: string;
  nickname: string;
  lastFetchedAt: string | null;
  fetchedNoteIds: string[];
  cursor: string | null;
  allFetched: boolean;
}
