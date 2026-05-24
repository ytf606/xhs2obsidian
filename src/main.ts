import { App, Notice, Plugin, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS, RedbookPullSettings, SYNC_TARGET_LABELS, SyncTarget, SEARCH_SORT_LABELS, SearchSort, SearchNoteType, SearchTimeFilter, SearchRangeFilter, SearchPosFilter } from './types';
import { SignManager } from './sign-manager';
import { log, logError, LOG_FILE } from './logger';
import { XhsApi } from './xhs-api';
import { VaultWriter } from './vault-writer';
import { SyncEngine } from './sync-engine';
import { LoginModal } from './login-modal';
import { testAiConfig } from './ai-classifier';

export default class RedbookPullPlugin extends Plugin {
  settings: RedbookPullSettings;
  private sign: SignManager;
  private api: XhsApi;
  private writer: VaultWriter;
  private engine: SyncEngine;
  private autoSyncTimer: number | null = null;
  private autoSearchTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.sign = new SignManager();
    this.api = new XhsApi(this.sign, () => this.settings.cookies, () => this.settings.userId);
    this.rebuildEngine();

    log('[RedbookPull] plugin loaded, log file:', LOG_FILE);
    this.sign.init();

    if (this.settings.a1Cookie && !this.settings.userId) {
      this.fetchUserInfo().catch(e => logError('[RedbookPull] fetchUserInfo failed', e));
    }

    this.addRibbonIcon('download-cloud', 'Redbook Pull：同步', () => {
      this.engine.sync(this.settings.syncTarget);
    });

    this.addCommand({
      id: 'sync-bookmarks',
      name: '同步收藏',
      callback: () => this.engine.sync('bookmarks'),
    });
    this.addCommand({
      id: 'sync-posts',
      name: '同步个人帖子',
      callback: () => this.engine.sync('posts'),
    });
    this.addCommand({
      id: 'sync-likes',
      name: '同步点赞',
      callback: () => this.engine.sync('likes'),
    });
    this.addCommand({
      id: 'login',
      name: '登录小红书',
      callback: () => this.openLoginModal(),
    });
    this.addCommand({
      id: 'sync-search',
      name: '按关键词搜索同步',
      callback: () => this.engine.syncSearch(),
    });

    this.addSettingTab(new RedbookPullSettingTab(this.app, this));

    if (this.settings.autoSyncEnabled) {
      this.startAutoSync();
    }
    if (this.settings.autoSearchEnabled) {
      this.startAutoSearch();
    }
  }

  onunload(): void {
    this.stopAutoSync();
    this.stopAutoSearch();
    this.sign.destroy();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  rebuildEngine(): void {
    this.writer = new VaultWriter(
      this.app.vault,
      this.settings.rootFolder,
      this.settings.syncTags,
      (url) => this.sign.fetchBinary(url),
    );
    this.engine = new SyncEngine(this.settings, this.api, this.writer, () => this.saveSettings());
  }

  openLoginModal(): void {
    new LoginModal(this.app, this.settings, async () => {
      await this.saveSettings();
    }).open();
  }

  async fetchUserInfo(): Promise<void> {
    try {
      const { userId, nickname } = await this.api.getMe();
      this.settings.userId = userId;
      this.settings.userName = nickname;
      await this.saveSettings();
      new Notice(`Redbook Pull：已登录为 ${nickname}`);
    } catch (e: any) {
      logError('[RedbookPull] fetchUserInfo failed', e);
    }
  }

  startAutoSync(): void {
    this.stopAutoSync();
    const ms = this.settings.syncIntervalMinutes * 60 * 1000;
    this.autoSyncTimer = window.setInterval(() => {
      this.engine.sync(this.settings.syncTarget);
    }, ms);
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  startAutoSearch(): void {
    this.stopAutoSearch();
    const ms = this.settings.searchIntervalMinutes * 60 * 1000;
    this.autoSearchTimer = window.setInterval(() => {
      this.engine.syncSearch();
    }, ms);
  }

  stopAutoSearch(): void {
    if (this.autoSearchTimer !== null) {
      window.clearInterval(this.autoSearchTimer);
      this.autoSearchTimer = null;
    }
  }
}

class RedbookPullSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: RedbookPullPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const section = (title: string, desc?: string) => {
      const wrap = containerEl.createEl('div');
      wrap.style.cssText =
        'margin:28px 0 2px 0;padding-bottom:10px;' +
        'border-bottom:2px solid var(--background-modifier-border);';
      const h = wrap.createEl('h2', { text: title });
      h.style.cssText = 'margin:0 0 2px 0;font-size:15px;font-weight:600;';
      if (desc) {
        const d = wrap.createEl('p', { text: desc });
        d.style.cssText = 'margin:0;font-size:12px;color:var(--text-muted);';
      }
    };

    // ═══════════════════════════════════════════════════════════
    // 1. 账号设置
    // ═══════════════════════════════════════════════════════════
    section('账号设置');

    const isLoggedIn = !!this.plugin.settings.a1Cookie;
    const displayName = this.plugin.settings.userName;
    const loginSetting = new Setting(containerEl)
      .setName(isLoggedIn ? `已登录：${displayName || '未知用户'}` : '未登录小红书')
      .setDesc(isLoggedIn ? 'Cookie 有效期约 30–90 天，过期后重新登录即可' : '登录后才能同步内容');

    if (isLoggedIn) {
      loginSetting.addButton(btn => btn
        .setButtonText('重新登录')
        .onClick(() => this.openLogin()));
    } else {
      loginSetting.addButton(btn => btn
        .setButtonText('登录')
        .setCta()
        .onClick(() => this.openLogin()));
    }

    // 三栏数据卡片
    const statsGrid = containerEl.createEl('div');
    statsGrid.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0 4px 0;';
    for (const [key, label] of Object.entries(SYNC_TARGET_LABELS) as [SyncTarget, string][]) {
      const count = this.plugin.settings.syncedIds[key]?.length ?? 0;
      const allSynced = this.plugin.settings.allSynced[key];
      const card = statsGrid.createEl('div');
      card.style.cssText =
        'padding:12px 16px;border-radius:8px;' +
        'background:var(--background-secondary);' +
        'border:1px solid var(--background-modifier-border);';
      const n = card.createEl('div', { text: String(count) });
      n.style.cssText = 'font-size:22px;font-weight:700;line-height:1.1;';
      const lbl = card.createEl('div', { text: label });
      lbl.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:3px;';
      if (allSynced) {
        const badge = card.createEl('div', { text: '✓ 已全部同步' });
        badge.style.cssText = 'font-size:11px;color:var(--color-green);margin-top:4px;';
      }
    }

    new Setting(containerEl)
      .setName('清除同步缓存')
      .setDesc('重置已同步记录，不会删除已有文件，下次同步会重新拉取全部内容')
      .addButton(btn => btn
        .setButtonText('清除缓存')
        .setWarning()
        .onClick(async () => {
          for (const key of Object.keys(SYNC_TARGET_LABELS) as SyncTarget[]) {
            this.plugin.settings.syncCursors[key] = null;
            this.plugin.settings.syncedIds[key] = [];
            this.plugin.settings.allSynced[key] = false;
          }
          await this.plugin.saveSettings();
          new Notice('XHS Sync：同步缓存已清除');
          this.display();
        }));

    // ═══════════════════════════════════════════════════════════
    // 2. 同步设置
    // ═══════════════════════════════════════════════════════════
    section('同步设置');

    // 存储目录：全宽
    new Setting(containerEl)
      .setName('存储目录')
      .setDesc('同步内容在 Vault 中的根目录名')
      .addText(text => text
        .setPlaceholder('RedNote')
        .setValue(this.plugin.settings.rootFolder)
        .onChange(async v => {
          this.plugin.settings.rootFolder = v.trim() || 'RedNote';
          await this.plugin.saveSettings();
          this.plugin.rebuildEngine();
        }));

    // 同步内容 + 每批数量：2 列并排
    const syncRow = containerEl.createEl('div');
    syncRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:4px 0;';

    const syncTargetCell = syncRow.createEl('div');
    syncTargetCell.style.cssText =
      'padding:10px 14px;border-radius:8px;background:var(--background-secondary);' +
      'border:1px solid var(--background-modifier-border);';
    syncTargetCell.createEl('div', { text: '同步内容' }).style.cssText =
      'font-size:12px;color:var(--text-muted);margin-bottom:6px;';
    const targetSel = syncTargetCell.createEl('select') as HTMLSelectElement;
    targetSel.style.cssText =
      'width:100%;background:var(--background-primary);color:var(--text-normal);' +
      'border:1px solid var(--background-modifier-border);border-radius:4px;' +
      'padding:4px 8px;font-size:13px;cursor:pointer;';
    for (const [key, label] of Object.entries(SYNC_TARGET_LABELS)) {
      const o = targetSel.createEl('option', { text: label, value: key }) as HTMLOptionElement;
      if (key === this.plugin.settings.syncTarget) o.selected = true;
    }
    targetSel.addEventListener('change', async () => {
      this.plugin.settings.syncTarget = targetSel.value as SyncTarget;
      await this.plugin.saveSettings();
    });

    const batchCell = syncRow.createEl('div');
    batchCell.style.cssText =
      'padding:10px 14px;border-radius:8px;background:var(--background-secondary);' +
      'border:1px solid var(--background-modifier-border);';
    batchCell.createEl('div', { text: '每批数量' }).style.cssText =
      'font-size:12px;color:var(--text-muted);margin-bottom:6px;';
    const batchDesc = batchCell.createEl('div', { text: '建议 5–10，过大易触发限流' });
    batchDesc.style.cssText = 'font-size:11px;color:var(--text-faint);margin-bottom:6px;';
    const batchInput = batchCell.createEl('input') as HTMLInputElement;
    batchInput.type = 'number';
    batchInput.min = '1'; batchInput.max = '20';
    batchInput.value = String(this.plugin.settings.syncBatchSize);
    batchInput.style.cssText =
      'width:72px;padding:4px 8px;border-radius:4px;font-size:13px;' +
      'border:1px solid var(--background-modifier-border);' +
      'background:var(--background-primary);color:var(--text-normal);';
    batchInput.addEventListener('change', async () => {
      const n = parseInt(batchInput.value);
      if (!isNaN(n) && n >= 1 && n <= 20) {
        this.plugin.settings.syncBatchSize = n;
        await this.plugin.saveSettings();
      }
    });

    // 同步标签 + 同步专辑：2 列 toggle 卡片（使用 Setting API）
    const toggleGrid = containerEl.createEl('div');
    toggleGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0;';

    const tagsCell = toggleGrid.createEl('div');
    tagsCell.style.cssText =
      'border-radius:8px;background:var(--background-secondary);' +
      'border:1px solid var(--background-modifier-border);overflow:hidden;';
    new Setting(tagsCell)
      .setName('同步标签')
      .setDesc('写入 frontmatter')
      .addToggle(t => t
        .setValue(this.plugin.settings.syncTags)
        .onChange(async v => {
          this.plugin.settings.syncTags = v;
          await this.plugin.saveSettings();
          this.plugin.rebuildEngine();
        }));

    const albumsCell = toggleGrid.createEl('div');
    albumsCell.style.cssText =
      'border-radius:8px;background:var(--background-secondary);' +
      'border:1px solid var(--background-modifier-border);overflow:hidden;';
    new Setting(albumsCell)
      .setName('同步专辑')
      .setDesc('收藏按专辑分目录')
      .addToggle(t => t
        .setValue(this.plugin.settings.syncAlbums)
        .onChange(async v => {
          this.plugin.settings.syncAlbums = v;
          await this.plugin.saveSettings();
        }));

    // 定时自动同步
    new Setting(containerEl)
      .setName('定时自动同步')
      .setDesc('后台按固定间隔同步，遇限流或登录失效时自动关闭')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSyncEnabled)
        .onChange(async v => {
          this.plugin.settings.autoSyncEnabled = v;
          await this.plugin.saveSettings();
          v ? this.plugin.startAutoSync() : this.plugin.stopAutoSync();
          this.display();
        }));

    if (this.plugin.settings.autoSyncEnabled) {
      new Setting(containerEl)
        .setName('同步间隔（分钟）')
        .setDesc('最小 5 分钟')
        .addText(text => {
          text.inputEl.style.width = '64px';
          text.setValue(String(this.plugin.settings.syncIntervalMinutes))
            .onChange(async v => {
              const n = parseInt(v);
              if (!isNaN(n) && n >= 5) {
                this.plugin.settings.syncIntervalMinutes = n;
                await this.plugin.saveSettings();
                this.plugin.startAutoSync();
              }
            });
        });
    }

    // ═══════════════════════════════════════════════════════════
    // 3. AI 分类
    // ═══════════════════════════════════════════════════════════
    section('AI 分类', '可选：同步时自动将笔记归入指定分类目录');

    new Setting(containerEl)
      .setName('启用 AI 分类')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableAiClassify)
        .onChange(async v => {
          this.plugin.settings.enableAiClassify = v;
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.enableAiClassify) {
      // API 配置收进一个缩进卡片
      const apiCard = containerEl.createEl('div');
      apiCard.style.cssText =
        'margin:4px 0 8px 0;padding:4px 0 4px 0;border-radius:8px;' +
        'background:var(--background-secondary);' +
        'border:1px solid var(--background-modifier-border);overflow:hidden;';

      new Setting(apiCard)
        .setName('API Key')
        .addText(text => {
          text.inputEl.type = 'password';
          text.setPlaceholder('sk-...')
            .setValue(this.plugin.settings.openaiApiKey)
            .onChange(async v => {
              this.plugin.settings.openaiApiKey = v.trim();
              await this.plugin.saveSettings();
            });
        });

      new Setting(apiCard)
        .setName('Base URL')
        .setDesc('需含 /v1，如 https://api.openai.com/v1')
        .addText(text => text
          .setPlaceholder('https://api.openai.com/v1')
          .setValue(this.plugin.settings.openaiBaseUrl)
          .onChange(async v => {
            this.plugin.settings.openaiBaseUrl = v.trim();
            await this.plugin.saveSettings();
          }));

      new Setting(apiCard)
        .setName('模型')
        .addText(text => text
          .setPlaceholder('gpt-4o-mini')
          .setValue(this.plugin.settings.openaiModel)
          .onChange(async v => {
            this.plugin.settings.openaiModel = v.trim();
            await this.plugin.saveSettings();
          }));

      const testSetting = new Setting(apiCard)
        .setName('测试连接')
        .setDesc('验证 API Key 和模型是否可用')
        .addButton(btn => btn
          .setButtonText('测试')
          .onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText('测试中…');
            const { ok, message } = await testAiConfig(
              this.plugin.settings.openaiApiKey,
              this.plugin.settings.openaiBaseUrl,
              this.plugin.settings.openaiModel,
            );
            btn.setDisabled(false);
            btn.setButtonText('测试');
            testSetting.setDesc(message);
            testSetting.descEl.style.color = ok ? 'var(--color-green)' : 'var(--text-error)';
          }));

      new Setting(containerEl)
        .setName('分类列表')
        .setDesc('输入分类名按回车添加；点击 × 删除')
        .addButton(btn => btn
          .setButtonText('从专辑目录加载')
          .onClick(async () => {
            const folders = await this.loadAlbumFolders();
            let added = 0;
            for (const f of folders) {
              if (!this.plugin.settings.aiCategories.includes(f)) {
                this.plugin.settings.aiCategories.push(f);
                added++;
              }
            }
            await this.plugin.saveSettings();
            if (added) new Notice(`XHS Sync：已加载 ${added} 个分类`);
            this.display();
          }));

      this.renderChips(
        containerEl,
        this.plugin.settings.aiCategories,
        async (item) => {
          this.plugin.settings.aiCategories =
            this.plugin.settings.aiCategories.filter(c => c !== item);
          await this.plugin.saveSettings();
          this.display();
        },
        async (item) => {
          if (!this.plugin.settings.aiCategories.includes(item)) {
            this.plugin.settings.aiCategories.push(item);
            await this.plugin.saveSettings();
            this.display();
          }
        },
        '输入分类名，按回车添加',
      );
    }

    // ═══════════════════════════════════════════════════════════
    // 4. 关键词同步
    // ═══════════════════════════════════════════════════════════
    section('关键词同步', '按关键词搜索小红书并同步匹配笔记');

    new Setting(containerEl)
      .setName('关键词列表')
      .setDesc('输入关键词按回车添加；点击 × 删除');

    this.renderChips(
      containerEl,
      this.plugin.settings.searchKeywords,
      async (item) => {
        this.plugin.settings.searchKeywords =
          this.plugin.settings.searchKeywords.filter(k => k !== item);
        await this.plugin.saveSettings();
        this.display();
      },
      async (item) => {
        if (!this.plugin.settings.searchKeywords.includes(item)) {
          this.plugin.settings.searchKeywords.push(item);
          await this.plugin.saveSettings();
          this.display();
        }
      },
      '输入关键词，按回车添加',
    );

    // 关键词状态卡片
    if (this.plugin.settings.searchKeywords.length > 0) {
      const kwGrid = containerEl.createEl('div');
      kwGrid.style.cssText =
        'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));' +
        'gap:6px;margin:4px 0 12px 0;';
      for (const kw of this.plugin.settings.searchKeywords) {
        const count = this.plugin.settings.searchedNoteIds[kw]?.length ?? 0;
        const allDone = this.plugin.settings.searchAllSynced[kw];
        const card = kwGrid.createEl('div');
        card.style.cssText =
          'padding:8px 12px;border-radius:6px;' +
          'background:var(--background-secondary);' +
          'border:1px solid var(--background-modifier-border);' +
          'display:flex;align-items:center;justify-content:space-between;gap:6px;';
        const info = card.createEl('div');
        info.style.cssText = 'min-width:0;';
        const nameEl = info.createEl('div', { text: `「${kw}」` });
        nameEl.style.cssText =
          'font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        const statusEl = info.createEl('div', {
          text: allDone ? `${count} 篇 · 已全部同步` : `${count} 篇`,
        });
        statusEl.style.cssText =
          `font-size:11px;margin-top:2px;color:${allDone ? 'var(--color-green)' : 'var(--text-muted)'};`;
        const resetBtn = card.createEl('button', { text: '重置' });
        resetBtn.style.cssText =
          'flex-shrink:0;font-size:11px;padding:2px 8px;cursor:pointer;border-radius:4px;' +
          'background:var(--background-modifier-border);border:none;color:var(--text-normal);';
        resetBtn.onclick = async () => {
          this.plugin.settings.searchPages[kw] = 1;
          this.plugin.settings.searchedNoteIds[kw] = [];
          this.plugin.settings.searchAllSynced[kw] = false;
          await this.plugin.saveSettings();
          this.display();
        };
      }
    }

    // 搜索筛选：3×2 紧凑 filter 格栅
    const FILTERS: { label: string; options: string[]; get: () => string; set: (v: string) => Promise<void> }[] = [
      {
        label: '排序依据',
        options: Object.keys(SEARCH_SORT_LABELS),
        get: () => this.plugin.settings.searchSort,
        set: async v => { this.plugin.settings.searchSort = v as SearchSort; await this.plugin.saveSettings(); },
      },
      {
        label: '笔记类型',
        options: ['不限', '视频', '图文'],
        get: () => this.plugin.settings.searchNoteType,
        set: async v => { this.plugin.settings.searchNoteType = v as SearchNoteType; await this.plugin.saveSettings(); },
      },
      {
        label: '发布时间',
        options: ['不限', '一天内', '一周内', '半年内'],
        get: () => this.plugin.settings.searchTimeFilter,
        set: async v => { this.plugin.settings.searchTimeFilter = v as SearchTimeFilter; await this.plugin.saveSettings(); },
      },
      {
        label: '搜索范围',
        options: ['不限', '已看过', '未看过', '已关注'],
        get: () => this.plugin.settings.searchRangeFilter,
        set: async v => { this.plugin.settings.searchRangeFilter = v as SearchRangeFilter; await this.plugin.saveSettings(); },
      },
      {
        label: '位置距离',
        options: ['不限', '同城', '附近'],
        get: () => this.plugin.settings.searchPosFilter,
        set: async v => { this.plugin.settings.searchPosFilter = v as SearchPosFilter; await this.plugin.saveSettings(); },
      },
    ];

    const filterGrid = containerEl.createEl('div');
    filterGrid.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0;';

    for (const f of FILTERS) {
      const cell = filterGrid.createEl('div');
      cell.style.cssText =
        'padding:10px 12px;border-radius:8px;background:var(--background-secondary);' +
        'border:1px solid var(--background-modifier-border);';
      cell.createEl('div', { text: f.label }).style.cssText =
        'font-size:11px;color:var(--text-muted);margin-bottom:5px;';
      const sel = cell.createEl('select') as HTMLSelectElement;
      sel.style.cssText =
        'width:100%;background:var(--background-primary);color:var(--text-normal);' +
        'border:1px solid var(--background-modifier-border);border-radius:4px;' +
        'padding:3px 6px;font-size:13px;cursor:pointer;';
      for (const opt of f.options) {
        const displayLabel = f.label === '排序依据'
          ? (SEARCH_SORT_LABELS as Record<string, string>)[opt] ?? opt
          : opt;
        const o = sel.createEl('option', { text: displayLabel, value: opt }) as HTMLOptionElement;
        if (opt === f.get()) o.selected = true;
      }
      sel.addEventListener('change', () => f.set(sel.value));
    }

    // 每次搜索条数：单独一个小卡片补齐第 6 格
    const batchSearchCell = filterGrid.createEl('div');
    batchSearchCell.style.cssText =
      'padding:10px 12px;border-radius:8px;background:var(--background-secondary);' +
      'border:1px solid var(--background-modifier-border);';
    batchSearchCell.createEl('div', { text: '每次条数' }).style.cssText =
      'font-size:11px;color:var(--text-muted);margin-bottom:5px;';
    batchSearchCell.createEl('div', { text: 'API 每页固定 20 条' }).style.cssText =
      'font-size:10px;color:var(--text-faint);margin-bottom:5px;';
    const batchSearchInput = batchSearchCell.createEl('input') as HTMLInputElement;
    batchSearchInput.type = 'number';
    batchSearchInput.min = '1'; batchSearchInput.max = '100';
    batchSearchInput.value = String(this.plugin.settings.searchBatchSize);
    batchSearchInput.style.cssText =
      'width:72px;padding:3px 6px;border-radius:4px;font-size:13px;' +
      'border:1px solid var(--background-modifier-border);' +
      'background:var(--background-primary);color:var(--text-normal);';
    batchSearchInput.addEventListener('change', async () => {
      const n = parseInt(batchSearchInput.value);
      if (!isNaN(n) && n >= 1 && n <= 100) {
        this.plugin.settings.searchBatchSize = n;
        await this.plugin.saveSettings();
      }
    });

    // 定时自动搜索
    new Setting(containerEl)
      .setName('定时自动搜索')
      .setDesc('按设定间隔自动执行关键词搜索同步')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSearchEnabled)
        .onChange(async v => {
          this.plugin.settings.autoSearchEnabled = v;
          await this.plugin.saveSettings();
          v ? this.plugin.startAutoSearch() : this.plugin.stopAutoSearch();
          this.display();
        }));

    if (this.plugin.settings.autoSearchEnabled) {
      new Setting(containerEl)
        .setName('搜索间隔（分钟）')
        .setDesc('最小 30 分钟，避免触发小红书封控')
        .addText(text => {
          text.inputEl.style.width = '64px';
          text.setValue(String(this.plugin.settings.searchIntervalMinutes))
            .onChange(async v => {
              const n = parseInt(v);
              if (!isNaN(n) && n >= 30) {
                this.plugin.settings.searchIntervalMinutes = n;
                await this.plugin.saveSettings();
                this.plugin.startAutoSearch();
              }
            });
        });
    }

    new Setting(containerEl)
      .setName('立即执行搜索同步')
      .setDesc('重置各关键词同步状态后立即拉取，已下载内容不会重复同步')
      .addButton(btn => btn
        .setButtonText('立即搜索')
        .setCta()
        .onClick(async () => {
          for (const kw of this.plugin.settings.searchKeywords) {
            this.plugin.settings.searchAllSynced[kw] = false;
            this.plugin.settings.searchPages[kw] = 1;
          }
          await this.plugin.saveSettings();
          this.plugin.engine.syncSearch();
        }));
  }

  private renderChips(
    containerEl: HTMLElement,
    items: string[],
    onRemove: (item: string) => Promise<void>,
    onAdd: (item: string) => Promise<void>,
    placeholder: string,
  ): void {
    const chipsEl = containerEl.createEl('div');
    chipsEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:4px 0 6px 0;';
    for (const item of items) {
      const chip = chipsEl.createEl('span');
      chip.style.cssText =
        'display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;' +
        'background:var(--background-modifier-border);font-size:12px;';
      chip.createSpan({ text: item });
      const rm = chip.createEl('button', { text: '×' });
      rm.style.cssText =
        'background:none;border:none;cursor:pointer;padding:0 0 0 2px;' +
        'color:var(--text-muted);font-size:14px;line-height:1;';
      rm.onclick = () => onRemove(item);
    }
    const inputEl = containerEl.createEl('input') as HTMLInputElement;
    inputEl.type = 'text';
    inputEl.placeholder = placeholder;
    inputEl.style.cssText =
      'width:100%;padding:6px 10px;margin-bottom:4px;box-sizing:border-box;' +
      'border:1px solid var(--background-modifier-border);border-radius:4px;' +
      'background:var(--background-primary);color:var(--text-normal);font-size:14px;';
    inputEl.addEventListener('keydown', async (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const val = inputEl.value.trim();
      if (val) await onAdd(val);
    });
  }

  private openLogin(): void {
    new LoginModal(this.app, this.plugin.settings, async () => {
      await this.plugin.saveSettings();
      this.display();
      this.plugin.fetchUserInfo().then(() => this.display());
    }).open();
  }

  private async loadAlbumFolders(): Promise<string[]> {
    const bookmarksPath = normalizePath(`${this.plugin.settings.rootFolder}/Bookmarks`);
    try {
      const items = await this.app.vault.adapter.list(bookmarksPath);
      return items.folders
        .map(f => f.split('/').pop()!)
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
