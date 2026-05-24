import { Notice } from 'obsidian';
import { RedbookPullSettings, SyncTarget, SYNC_TARGET_LABELS, XhsNote, SearchSort } from './types';
import { XhsApi } from './xhs-api';
import { VaultWriter } from './vault-writer';
import { classifyNote } from './ai-classifier';
import { log, logError } from './logger';

export class SyncEngine {
  private syncing = false;

  constructor(
    private settings: RedbookPullSettings,
    private api: XhsApi,
    private writer: VaultWriter,
    private saveData: () => Promise<void>,
  ) {}

  isSyncing(): boolean {
    return this.syncing;
  }

  async sync(target: SyncTarget): Promise<void> {
    if (this.syncing) {
      new Notice('Redbook Pull：同步正在进行中，请稍候');
      return;
    }

    if (this.settings.allSynced[target]) {
      new Notice(`Redbook Pull：${SYNC_TARGET_LABELS[target]}已全部同步完毕`);
      return;
    }

    if (!this.settings.a1Cookie) {
      new Notice('Redbook Pull：请先登录小红书');
      return;
    }

    if (target === 'posts' && !this.settings.userId) {
      new Notice('Redbook Pull：正在获取账号信息，请稍后再试');
      return;
    }

    this.syncing = true;
    const label = SYNC_TARGET_LABELS[target];
    new Notice(`Redbook Pull：开始同步${label}…`);

    let savedCount = 0;
    let skippedCount = 0;

    try {
      while (true) {
        const cursor = this.settings.syncCursors[target];
        const { items, cursor: nextCursor, hasMore } = await this.fetch(target, cursor);

        if (items.length === 0 && !hasMore) {
          this.settings.allSynced[target] = true;
          await this.saveData();
          break;
        }

        const syncedSet = new Set(this.settings.syncedIds[target]);
        const newItems = items.filter(n => !syncedSet.has(n.id));

        if (newItems.length === 0 && items.length > 0) {
          // 本批全部已同步，说明增量同步追上了
          this.settings.syncCursors[target] = nextCursor;
          await this.saveData();
          if (!hasMore) {
            this.settings.allSynced[target] = true;
            await this.saveData();
          }
          break;
        }

        for (const listNote of newItems) {
          // Fetch full note content (list API only returns cover/title, no desc/images/tags)
          let note: XhsNote = listNote;
          try {
            const detail = await this.api.fetchNoteDetail(listNote.id, listNote.xsecToken);
            if (detail) note = detail;
            await randomSleep(3000, 15000);
          } catch (e: any) {
            logError('[SyncEngine] fetchNoteDetail error:', e.message);
          }

          let category: string | undefined;
          if (
            this.settings.enableAiClassify &&
            this.settings.aiCategories.length > 0 &&
            this.settings.openaiApiKey
          ) {
            try {
              category = await classifyNote(
                note.title || note.desc.slice(0, 40),
                note.desc,
                note.tagList.map(t => t.name),
                this.settings.aiCategories,
                this.settings.openaiApiKey,
                this.settings.openaiBaseUrl,
                this.settings.openaiModel,
              ) ?? undefined;
              if (category) log(`[SyncEngine] AI classified "${note.title}" → ${category}`);
            } catch (e: any) {
              logError('[SyncEngine] AI classify error:', e.message);
            }
          }
          await this.writer.write(note, target, category);
          this.settings.syncedIds[target].push(listNote.id);
          savedCount++;
        }

        skippedCount += items.length - newItems.length;
        this.settings.syncCursors[target] = nextCursor;
        await this.saveData();

        if (!hasMore) {
          this.settings.allSynced[target] = true;
          await this.saveData();
          break;
        }

        // 批次间延迟，模拟人工翻页节奏
        await randomSleep(5000, 25000);
      }

      const msg = savedCount > 0
        ? `Redbook Pull：${label}同步完成，新增 ${savedCount} 篇` +
          (skippedCount > 0 ? `，跳过 ${skippedCount} 篇（已存在）` : '')
        : `Redbook Pull：${label}无新内容`;
      new Notice(msg);
    } catch (e: any) {
      new Notice(`Redbook Pull：同步出错 — ${e.message}`);
      console.error('[RedbookPull] sync error', e);
    } finally {
      this.syncing = false;
    }
  }

  async syncSearch(): Promise<void> {
    log(`[SyncEngine] syncSearch called, syncing=${this.syncing}, keywords=${this.settings.searchKeywords.length}, hasCookie=${!!this.settings.a1Cookie}`);
    if (this.syncing) {
      new Notice('Redbook Pull：同步正在进行中，请稍候');
      return;
    }
    if (!this.settings.searchKeywords.length) {
      new Notice('Redbook Pull：请先在设置中添加搜索关键词');
      return;
    }
    if (!this.settings.a1Cookie) {
      new Notice('Redbook Pull：请先登录小红书');
      return;
    }

    this.syncing = true;
    let totalSaved = 0;

    try {
      for (let ki = 0; ki < this.settings.searchKeywords.length; ki++) {
        const keyword = this.settings.searchKeywords[ki];
        log(`[SyncEngine] keyword="${keyword}" allSynced=${this.settings.searchAllSynced[keyword]} page=${this.settings.searchPages[keyword] ?? 1}`);
        if (this.settings.searchAllSynced[keyword]) continue;

        new Notice(`Redbook Pull：搜索「${keyword}」…`);
        let savedCount = 0;
        let quota = this.settings.searchBatchSize;

        try {
          while (quota > 0) {
            const page = this.settings.searchPages[keyword] ?? 1;
            const { items, hasMore } = await this.api.searchNotes(
              keyword, page,
              this.settings.searchSort as SearchSort,
              this.settings.searchNoteType,
              this.settings.searchTimeFilter,
              this.settings.searchRangeFilter,
              this.settings.searchPosFilter,
            );

            if (items.length === 0) {
              this.settings.searchAllSynced[keyword] = true;
              await this.saveData();
              break;
            }

            if (!this.settings.searchedNoteIds[keyword]) this.settings.searchedNoteIds[keyword] = [];
            const syncedSet = new Set(this.settings.searchedNoteIds[keyword]);
            const newItems = items.filter(n => !syncedSet.has(n.id));

            if (newItems.length === 0) {
              // 本页全部已同步，翻页继续
              this.settings.searchPages[keyword] = page + 1;
              await this.saveData();
              if (!hasMore) { this.settings.searchAllSynced[keyword] = true; await this.saveData(); }
              break;
            }

            const toProcess = newItems.slice(0, quota);
            for (const listNote of toProcess) {
              let note: XhsNote = listNote;
              try {
                const detail = await this.api.fetchNoteDetail(listNote.id, listNote.xsecToken);
                if (detail) note = detail;
                await randomSleep(3000, 15000);
              } catch (e: any) {
                logError('[SyncEngine] search fetchNoteDetail error:', e.message);
              }
              await this.writer.write(note, 'search', keyword);
              this.settings.searchedNoteIds[keyword].push(listNote.id);
              savedCount++;
              totalSaved++;
              quota--;
            }

            const pageExhausted = toProcess.length === newItems.length;
            if (pageExhausted) {
              // 本页新内容全部处理完，翻页
              this.settings.searchPages[keyword] = page + 1;
              await this.saveData();
              if (!hasMore) { this.settings.searchAllSynced[keyword] = true; await this.saveData(); break; }
              if (quota > 0) await randomSleep(8000, 20000);
            } else {
              // 配额用完，停在当前页，下次从同一页继续（已处理的 id 会被跳过）
              await this.saveData();
            }
          }

          new Notice(`Redbook Pull：「${keyword}」完成，新增 ${savedCount} 篇`);
        } catch (e: any) {
          new Notice(`Redbook Pull：「${keyword}」出错 — ${e.message}`);
          logError(`[SyncEngine] search error for "${keyword}":`, e.message);
        }

        // 关键词之间额外等待，避免触发封控
        if (ki < this.settings.searchKeywords.length - 1) {
          await randomSleep(15000, 30000);
        }
      }

      if (totalSaved > 0) new Notice(`Redbook Pull：搜索同步完成，共新增 ${totalSaved} 篇`);
      else new Notice('Redbook Pull：搜索无新内容');
    } catch (e: any) {
      new Notice(`Redbook Pull：搜索同步出错 — ${e.message}`);
      logError('[SyncEngine] syncSearch error:', e);
    } finally {
      this.syncing = false;
    }
  }

  async syncFollowedAccounts(): Promise<void> {
    if (this.syncing) {
      new Notice('Redbook Pull：同步正在进行中，请稍候');
      return;
    }
    if (!this.settings.followedAccounts.length) {
      new Notice('Redbook Pull：请先在设置中添加订阅账号');
      return;
    }
    if (!this.settings.a1Cookie) {
      new Notice('Redbook Pull：请先登录小红书');
      return;
    }

    this.syncing = true;
    let totalSaved = 0;
    new Notice(`Redbook Pull：开始同步 ${this.settings.followedAccounts.length} 个订阅账号…`);

    try {
      for (let i = 0; i < this.settings.followedAccounts.length; i++) {
        const account = this.settings.followedAccounts[i];

        let nickname = account.nickname || account.userId;
        new Notice(`Redbook Pull：正在加载「${nickname}」的主页…`);
        let savedCount = 0;

        try {
          // Load profile page once — gets both user info and initial note list
          const { profile, notes } = await this.api.fetchUserProfileAndNotes(account.userId);
          nickname = profile.nickname || nickname;
          account.nickname = nickname;
          await this.writer.writeUserProfile(profile);
          log(`[SyncEngine] profile fetched for ${nickname}, ${notes.length} notes on page`);

          const syncedSet = new Set(account.fetchedNoteIds);
          const newNotes = notes.filter(n => !syncedSet.has(n.id)).slice(0, 30);

          if (newNotes.length === 0) {
            new Notice(`Redbook Pull：「${nickname}」无新内容`);
          } else {
            new Notice(`Redbook Pull：同步「${nickname}」${newNotes.length} 篇新帖子…`);
            for (const listNote of newNotes) {
              let note: XhsNote = listNote;
              try {
                const detail = await this.api.fetchNoteDetail(listNote.id, listNote.xsecToken);
                if (detail) note = detail;
                await randomSleep(3000, 12000);
              } catch (e: any) {
                logError('[SyncEngine] follow fetchNoteDetail error:', e.message);
              }
              await this.writer.writeUserNote(note, nickname);
              account.fetchedNoteIds.push(listNote.id);
              savedCount++;
              totalSaved++;
            }
            account.lastFetchedAt = new Date().toISOString();
            await this.saveData();
            new Notice(`Redbook Pull：「${nickname}」完成，新增 ${savedCount} 篇`);
          }
        } catch (e: any) {
          new Notice(`Redbook Pull：「${nickname}」出错 — ${e.message}`);
          logError(`[SyncEngine] follow sync error for ${account.userId}:`, e.message);
        }

        // 账号间随机延迟（分钟 → 毫秒）
        if (i < this.settings.followedAccounts.length - 1) {
          const minMs = this.settings.followMinDelayMin * 60 * 1000;
          const maxMs = this.settings.followMaxDelayMin * 60 * 1000;
          await randomSleep(minMs, maxMs);
        }
      }

      if (totalSaved > 0) new Notice(`Redbook Pull：订阅同步完成，共新增 ${totalSaved} 篇`);
      else new Notice('Redbook Pull：订阅账号无新内容');
    } catch (e: any) {
      new Notice(`Redbook Pull：订阅同步出错 — ${e.message}`);
      logError('[SyncEngine] syncFollowedAccounts error:', e);
    } finally {
      this.syncing = false;
    }
  }

  private async fetch(target: SyncTarget, cursor: string | null) {
    const num = this.settings.syncBatchSize;
    switch (target) {
      case 'posts':
        return this.api.fetchPosts(this.settings.userId, cursor, num);
      case 'bookmarks':
        return this.api.fetchBookmarks(cursor, num);
      case 'likes':
        return this.api.fetchLikes(cursor, num);
    }
  }
}

function randomSleep(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}
