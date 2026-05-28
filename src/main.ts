import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, addIcon, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS, RedbookPullSettings, SYNC_TARGET_LABELS, SyncTarget, SEARCH_SORT_LABELS, SearchSort, SearchNoteType, SearchTimeFilter, SearchRangeFilter, SearchPosFilter, FollowedAccount, HotspotCategory } from './types';
import { SignManager } from './sign-manager';
import { log, logError, LOG_FILE } from './logger';
import { XhsApi } from './xhs-api';
import { VaultWriter } from './vault-writer';
import { SyncEngine } from './sync-engine';
import { HotspotEngine } from './hotspot-engine';
import { LoginModal } from './login-modal';
import { testAiConfig } from './ai-classifier';
import { suggestHotspotKeywords } from './hotspot-analyzer';

export default class RedbookPullPlugin extends Plugin {
  settings: RedbookPullSettings;
  private sign: SignManager;
  private api: XhsApi;
  private writer: VaultWriter;
  private engine: SyncEngine;
  private hotspot: HotspotEngine;
  private autoSyncTimer: number | null = null;
  private autoSearchTimer: number | null = null;
  private autoFollowTimer: number | null = null;

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

    addIcon('xhs-sync', `
      <rect width="100" height="100" rx="20" ry="20" fill="#ff2442"/>
      <rect x="9" y="20" width="32" height="48" rx="4" ry="4" fill="white" opacity="0.95"/>
      <polygon points="9,68 25,57 41,68 41,20 9,20" fill="white" opacity="0.95"/>
      <line x1="15" y1="32" x2="35" y2="32" stroke="#ff2442" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="15" y1="41" x2="35" y2="41" stroke="#ff2442" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="15" y1="50" x2="27" y2="50" stroke="#ff2442" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="49" y1="50" x2="60" y2="50" stroke="white" stroke-width="3.5" stroke-linecap="round"/>
      <polyline points="56,44 62,50 56,56" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <polygon points="80,18 96,50 80,55" fill="white" opacity="0.95"/>
      <polygon points="80,18 64,50 80,55" fill="white" opacity="0.72"/>
      <polygon points="80,55 96,50 80,88" fill="white" opacity="0.42"/>
      <polygon points="80,55 64,50 80,88" fill="white" opacity="0.25"/>
    `);

    this.addRibbonIcon('xhs-sync', 'XHS Sync：同步', () => {
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
    this.addCommand({
      id: 'sync-followed-accounts',
      name: '同步订阅账号',
      callback: () => this.engine.syncFollowedAccounts(),
    });
    this.addCommand({
      id: 'analyze-hotspots',
      name: '分析热点（分析所有热点分类）',
      callback: () => this.analyzeAllHotspots(),
    });

    this.addSettingTab(new RedbookPullSettingTab(this.app, this));

    if (this.settings.autoSyncEnabled) {
      this.startAutoSync();
    }
    if (this.settings.autoSearchEnabled) {
      this.startAutoSearch();
    }
    if (this.settings.autoFollowEnabled) {
      this.startAutoFollow();
    }
  }

  onunload(): void {
    this.stopAutoSync();
    this.stopAutoSearch();
    this.stopAutoFollow();
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
    this.hotspot = new HotspotEngine(this.settings, this.api, this.app.vault, this.writer, () => this.saveSettings());
  }

  async analyzeAllHotspots(): Promise<void> {
    const categories = this.settings.hotspotCategories;
    if (!categories.length) {
      new Notice('热点管理：请先在设置中添加热点分类');
      return;
    }
    for (const cat of categories) {
      await this.hotspot.analyzeCategory(cat);
    }
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

  startAutoFollow(): void {
    this.stopAutoFollow();
    const ms = this.settings.followIntervalMinutes * 60 * 1000;
    this.autoFollowTimer = window.setInterval(() => {
      this.engine.syncFollowedAccounts();
    }, ms);
  }

  stopAutoFollow(): void {
    if (this.autoFollowTimer !== null) {
      window.clearInterval(this.autoFollowTimer);
      this.autoFollowTimer = null;
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

    // Each section() call creates a self-contained card (header + body) and returns the body element.
    // All content for a section is appended to the returned body, so it's visually enclosed.
    const SECTION_STYLES = [
      { icon: '👤', color: '#4f8ef7' },   // 账号设置
      { icon: '🔄', color: '#4caf82' },   // 同步设置
      { icon: '🤖', color: '#9c6fe8' },   // AI 分类
      { icon: '🔍', color: '#f4973b' },   // 关键词同步
      { icon: '📰', color: '#ff2442' },   // 账号订阅
      { icon: '🔥', color: '#e8632a' },   // 热点管理
    ];
    let sectionIdx = 0;
    const section = (title: string, desc?: string): HTMLElement => {
      const isFirst = sectionIdx === 0;
      const style = SECTION_STYLES[sectionIdx++ % SECTION_STYLES.length];
      const wrap = containerEl.createEl('div');
      wrap.style.cssText =
        `margin:${isFirst ? '4px' : '24px'} 0 0 0;border-radius:10px;overflow:hidden;` +
        `border:1px solid var(--background-modifier-border);` +
        `border-left:4px solid ${style.color};`;
      const header = wrap.createEl('div');
      header.style.cssText =
        'padding:10px 16px;border-bottom:1px solid var(--background-modifier-border);';
      const row = header.createEl('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;';
      row.createEl('span', { text: style.icon }).style.cssText = 'font-size:18px;line-height:1;';
      const h = row.createEl('span', { text: title });
      h.style.cssText = 'font-size:15px;font-weight:700;color:var(--text-normal);letter-spacing:0.01em;';
      if (desc) {
        const d = header.createEl('p', { text: desc });
        d.style.cssText = 'margin:5px 0 0 26px;font-size:12px;color:var(--text-muted);line-height:1.5;';
      }
      const body = wrap.createEl('div');
      body.style.cssText = 'padding:4px 0 8px 0;';
      return body;
    };

    // Comment-fetch card: toggle + max-count input. Takes explicit container so it lands inside the right section body.
    const mkCommentCard = (
      container: HTMLElement,
      enabled: boolean,
      onToggle: (v: boolean) => Promise<void>,
      maxCount: number,
      onMaxChange: (n: number) => Promise<void>,
    ) => {
      const card = container.createEl('div');
      card.style.cssText =
        'margin:4px 16px 4px 16px;border-radius:8px;overflow:hidden;' +
        'border:1px solid var(--background-modifier-border);';
      new Setting(card)
        .setName('💬 抓取评论')
        .setDesc('每次请求间隔 30 秒–5 分钟，开启后同步耗时显著增加')
        .addToggle(t => t.setValue(enabled).onChange(onToggle));
      new Setting(card)
        .setName('最大评论数')
        .setDesc('每帖抓取主评论 + 子评论的总上限，默认 100')
        .addText(text => {
          text.inputEl.type = 'number';
          text.inputEl.min = '10';
          text.inputEl.max = '500';
          text.inputEl.style.width = '72px';
          text.setValue(String(maxCount)).onChange(async v => {
            const n = parseInt(v);
            if (!isNaN(n) && n >= 10) await onMaxChange(n);
          });
        });
    };

    // ═══════════════════════════════════════════════════════════
    // 1. 账号设置
    // ═══════════════════════════════════════════════════════════
    const acctBody = section('账号设置');

    const isLoggedIn = !!this.plugin.settings.a1Cookie;
    const displayName = this.plugin.settings.userName;
    const loginSetting = new Setting(acctBody)
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
    const statsGrid = acctBody.createEl('div');
    statsGrid.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:4px 16px 4px 16px;';
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

    new Setting(acctBody)
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
    const syncBody = section('同步设置');

    // 存储目录：全宽
    new Setting(syncBody)
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
    const syncRow = syncBody.createEl('div');
    syncRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:4px 16px;';

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
    const toggleGrid = syncBody.createEl('div');
    toggleGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 16px;';

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

    mkCommentCard(
      syncBody,
      this.plugin.settings.enableCommentSync,
      async v => { this.plugin.settings.enableCommentSync = v; await this.plugin.saveSettings(); },
      this.plugin.settings.commentMaxCount,
      async n => { this.plugin.settings.commentMaxCount = n; await this.plugin.saveSettings(); },
    );

    // 定时自动同步
    new Setting(syncBody)
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
      new Setting(syncBody)
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
    const aiBody = section('AI 分类', '可选：同步时自动将笔记归入指定分类目录');

    new Setting(aiBody)
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
      const apiCard = aiBody.createEl('div');
      apiCard.style.cssText =
        'margin:4px 16px 8px 16px;padding:4px 0;border-radius:8px;' +
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

      new Setting(aiBody)
        .setName('AI 打标')
        .setDesc('同步时自动为每篇笔记生成 3–6 个语义标签，追加到 frontmatter tags 字段，同时写入 aiTags 字段')
        .addToggle(t => t
          .setValue(this.plugin.settings.enableAiTagging)
          .onChange(async v => {
            this.plugin.settings.enableAiTagging = v;
            await this.plugin.saveSettings();
          }));

      new Setting(aiBody)
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

      const aiChipsWrap = aiBody.createEl('div');
      aiChipsWrap.style.cssText = 'padding:0 16px;';
      this.renderChips(
        aiChipsWrap,
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
    const searchBody = section('关键词同步', '按关键词搜索小红书并同步匹配笔记');

    new Setting(searchBody)
      .setName('关键词列表')
      .setDesc('输入关键词按回车添加；点击 × 删除');

    const kwChipsWrap = searchBody.createEl('div');
    kwChipsWrap.style.cssText = 'padding:0 16px;';
    this.renderChips(
      kwChipsWrap,
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
      const kwGrid = searchBody.createEl('div');
      kwGrid.style.cssText =
        'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));' +
        'gap:6px;margin:6px 16px 4px 16px;';
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

    const filterGrid = searchBody.createEl('div');
    filterGrid.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 16px;';

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

    mkCommentCard(
      searchBody,
      this.plugin.settings.enableSearchCommentSync,
      async v => { this.plugin.settings.enableSearchCommentSync = v; await this.plugin.saveSettings(); },
      this.plugin.settings.searchCommentMaxCount,
      async n => { this.plugin.settings.searchCommentMaxCount = n; await this.plugin.saveSettings(); },
    );

    // 定时自动搜索
    new Setting(searchBody)
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
      new Setting(searchBody)
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

    new Setting(searchBody)
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

    // ═══════════════════════════════════════════════════════════
    // 5. 账号订阅
    // ═══════════════════════════════════════════════════════════
    const followBody = section('账号订阅', '订阅指定小红书账号，自动下载其帖子到 Users 目录');

    // 添加账号输入
    new Setting(followBody)
      .setName('添加订阅账号')
      .setDesc('输入小红书 UID（主页 URL 中 /user/profile/ 后的字符串），按回车添加')
      .addText(text => {
        text.setPlaceholder('5f3a...（用户 ID）');
        text.inputEl.style.width = '220px';
        text.inputEl.addEventListener('keydown', async (e: KeyboardEvent) => {
          if (e.key !== 'Enter') return;
          const raw = text.getValue().trim();
          // 支持直接粘贴主页 URL
          const match = raw.match(/\/user\/profile\/([a-zA-Z0-9]+)/);
          const uid = match ? match[1] : raw;
          if (!uid) return;
          if (this.plugin.settings.followedAccounts.some(a => a.userId === uid)) {
            new Notice('XHS Sync：该账号已在订阅列表中');
            return;
          }
          const newAccount: FollowedAccount = {
            userId: uid, nickname: '', lastFetchedAt: null,
            fetchedNoteIds: [], cursor: null, allFetched: false,
          };
          this.plugin.settings.followedAccounts.push(newAccount);
          await this.plugin.saveSettings();
          text.setValue('');
          this.display();
        });
      });

    // 已订阅账号卡片列表
    if (this.plugin.settings.followedAccounts.length > 0) {
      const acctGrid = followBody.createEl('div');
      acctGrid.style.cssText =
        'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));' +
        'gap:8px;margin:4px 16px 4px 16px;';

      for (const acct of this.plugin.settings.followedAccounts) {
        const card = acctGrid.createEl('div');
        card.style.cssText =
          'padding:10px 12px;border-radius:8px;' +
          'background:var(--background-secondary);' +
          'border:1px solid var(--background-modifier-border);';
        const header = card.createEl('div');
        header.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:4px;';
        const info = header.createEl('div');
        info.style.cssText = 'min-width:0;';
        const nameEl = info.createEl('div', {
          text: acct.nickname || acct.userId.slice(0, 12) + '…',
        });
        nameEl.style.cssText = 'font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        const uidEl = info.createEl('div', { text: acct.userId.slice(0, 16) + (acct.userId.length > 16 ? '…' : '') });
        uidEl.style.cssText = 'font-size:10px;color:var(--text-faint);margin-top:1px;';
        const rmBtn = header.createEl('button', { text: '×' });
        rmBtn.style.cssText =
          'flex-shrink:0;background:none;border:none;cursor:pointer;' +
          'color:var(--text-muted);font-size:16px;line-height:1;padding:0;';
        rmBtn.onclick = async () => {
          this.plugin.settings.followedAccounts =
            this.plugin.settings.followedAccounts.filter(a => a.userId !== acct.userId);
          await this.plugin.saveSettings();
          this.display();
        };

        const count = acct.fetchedNoteIds.length;
        const lastSynced = acct.lastFetchedAt
          ? new Date(acct.lastFetchedAt).toLocaleDateString('zh-CN')
          : '未同步';
        const meta = card.createEl('div', {
          text: `${count} 篇 · ${lastSynced}` + (acct.allFetched ? ' · 已全部获取' : ''),
        });
        meta.style.cssText =
          `font-size:11px;margin-top:4px;color:${acct.allFetched ? 'var(--color-green)' : 'var(--text-muted)'};`;

        // 重置按钮
        const resetBtn = card.createEl('button', { text: '重置' });
        resetBtn.style.cssText =
          'margin-top:6px;font-size:11px;padding:2px 8px;cursor:pointer;border-radius:4px;' +
          'background:var(--background-modifier-border);border:none;color:var(--text-normal);';
        resetBtn.onclick = async () => {
          acct.fetchedNoteIds = [];
          acct.cursor = null;
          acct.allFetched = false;
          acct.lastFetchedAt = null;
          await this.plugin.saveSettings();
          this.display();
        };
      }
    }

    // 拉取设置：紧凑网格
    const followGrid = followBody.createEl('div');
    followGrid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 16px;';

    const mkFollowCell = (label: string, hint: string) => {
      const cell = followGrid.createEl('div');
      cell.style.cssText =
        'padding:10px 12px;border-radius:8px;background:var(--background-secondary);' +
        'border:1px solid var(--background-modifier-border);';
      cell.createEl('div', { text: label }).style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:3px;';
      if (hint) {
        cell.createEl('div', { text: hint }).style.cssText = 'font-size:10px;color:var(--text-faint);margin-bottom:4px;';
      }
      return cell;
    };

    const batchFollowCell = mkFollowCell('每次拉取条数', '');
    const batchFollowDesc = batchFollowCell.createEl('div', { text: '固定 30 条最新帖子' });
    batchFollowDesc.style.cssText = 'font-size:13px;font-weight:500;color:var(--text-normal);';

    const minDelayCell = mkFollowCell('账号间最小延迟（分钟）', '');
    const minDelayInput = minDelayCell.createEl('input') as HTMLInputElement;
    minDelayInput.type = 'number'; minDelayInput.min = '1'; minDelayInput.max = '60';
    minDelayInput.value = String(this.plugin.settings.followMinDelayMin);
    minDelayInput.style.cssText =
      'width:72px;padding:3px 6px;border-radius:4px;font-size:13px;' +
      'border:1px solid var(--background-modifier-border);' +
      'background:var(--background-primary);color:var(--text-normal);';
    minDelayInput.addEventListener('change', async () => {
      const n = parseInt(minDelayInput.value);
      if (!isNaN(n) && n >= 1) { this.plugin.settings.followMinDelayMin = n; await this.plugin.saveSettings(); }
    });

    const maxDelayCell = mkFollowCell('账号间最大延迟（分钟）', '');
    const maxDelayInput = maxDelayCell.createEl('input') as HTMLInputElement;
    maxDelayInput.type = 'number'; maxDelayInput.min = '1'; maxDelayInput.max = '120';
    maxDelayInput.value = String(this.plugin.settings.followMaxDelayMin);
    maxDelayInput.style.cssText =
      'width:72px;padding:3px 6px;border-radius:4px;font-size:13px;' +
      'border:1px solid var(--background-modifier-border);' +
      'background:var(--background-primary);color:var(--text-normal);';
    maxDelayInput.addEventListener('change', async () => {
      const n = parseInt(maxDelayInput.value);
      if (!isNaN(n) && n >= 1) { this.plugin.settings.followMaxDelayMin = n; await this.plugin.saveSettings(); }
    });

    mkCommentCard(
      followBody,
      this.plugin.settings.enableFollowCommentSync,
      async v => { this.plugin.settings.enableFollowCommentSync = v; await this.plugin.saveSettings(); },
      this.plugin.settings.followCommentMaxCount,
      async n => { this.plugin.settings.followCommentMaxCount = n; await this.plugin.saveSettings(); },
    );

    // 定时自动同步
    new Setting(followBody)
      .setName('定时自动同步订阅')
      .setDesc('按设定间隔自动同步全部订阅账号')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoFollowEnabled)
        .onChange(async v => {
          this.plugin.settings.autoFollowEnabled = v;
          await this.plugin.saveSettings();
          v ? this.plugin.startAutoFollow() : this.plugin.stopAutoFollow();
          this.display();
        }));

    if (this.plugin.settings.autoFollowEnabled) {
      new Setting(followBody)
        .setName('同步间隔（分钟）')
        .setDesc('最小 30 分钟')
        .addText(text => {
          text.inputEl.style.width = '64px';
          text.setValue(String(this.plugin.settings.followIntervalMinutes))
            .onChange(async v => {
              const n = parseInt(v);
              if (!isNaN(n) && n >= 30) {
                this.plugin.settings.followIntervalMinutes = n;
                await this.plugin.saveSettings();
                this.plugin.startAutoFollow();
              }
            });
        });
    }

    new Setting(followBody)
      .setName('立即同步订阅账号')
      .setDesc('拉取所有订阅账号的最新帖子，已下载内容不会重复同步')
      .addButton(btn => btn
        .setButtonText('立即同步')
        .setCta()
        .onClick(() => this.plugin.engine.syncFollowedAccounts()));

    // ═══════════════════════════════════════════════════════════
    // 6. 热点管理
    // ═══════════════════════════════════════════════════════════
    const hotspotBody = section(
      '热点管理',
      '按分类管理关键词，搜索「最多点赞」前 30 条，对前 15 条进行 AI 深度分析并保存日报',
    );

    // Preset categories with built-in keywords
    const HOTSPOT_PRESETS: Array<{ label: string; name: string; keywords: string[] }> = [
      {
        label: '📐 数学',
        name: '数学类',
        keywords: ['小学数学', '三年级数学', '数学思维', '数学启蒙', '小学数学学习方法', '四年级数学', '数学应用题', '小学奥数'],
      },
      {
        label: '🔤 英语',
        name: '英语类',
        keywords: ['英语启蒙', '自然拼读', '小学英语', '英语学习方法', '少儿英语', '英语阅读', '英语听力', '英语单词'],
      },
      {
        label: '📖 语文',
        name: '语文类',
        keywords: ['大语文', '阅读理解', '作文方法', '小学语文', '语文学习', '古诗词', '写作技巧', '语文启蒙'],
      },
    ];

    // Preset quick-add row
    const presetRow = hotspotBody.createEl('div');
    presetRow.style.cssText = 'padding:4px 16px 8px 16px;';
    presetRow.createEl('div', { text: '快速添加预设分类' }).style.cssText =
      'font-size:11px;color:var(--text-muted);margin-bottom:6px;';
    const presetBtnRow = presetRow.createEl('div');
    presetBtnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';

    for (const preset of HOTSPOT_PRESETS) {
      const alreadyAdded = this.plugin.settings.hotspotCategories.some(c => c.name === preset.name);
      const pb = presetBtnRow.createEl('button', { text: alreadyAdded ? `${preset.label} ✓` : preset.label });
      pb.style.cssText =
        `font-size:12px;padding:4px 12px;cursor:pointer;border-radius:12px;border:none;` +
        (alreadyAdded
          ? 'background:var(--background-modifier-border);color:var(--text-muted);'
          : 'background:var(--interactive-accent);color:var(--text-on-accent);');
      pb.disabled = alreadyAdded;
      pb.onclick = async () => {
        if (this.plugin.settings.hotspotCategories.some(c => c.name === preset.name)) return;
        this.plugin.settings.hotspotCategories.push({ name: preset.name, keywords: [...preset.keywords], lastAnalyzedAt: null });
        await this.plugin.saveSettings();
        this.display();
      };
    }

    // Custom category add input
    const addRow = hotspotBody.createEl('div');
    addRow.style.cssText = 'padding:0 16px 4px 16px;display:flex;gap:8px;align-items:center;';
    const addInput = addRow.createEl('input') as HTMLInputElement;
    addInput.type = 'text';
    addInput.placeholder = '自定义分类名称，按回车添加';
    addInput.style.cssText =
      'flex:1;padding:6px 10px;border-radius:4px;font-size:13px;' +
      'border:1px solid var(--background-modifier-border);' +
      'background:var(--background-primary);color:var(--text-normal);';
    addInput.addEventListener('keydown', async (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const name = addInput.value.trim();
      if (!name) return;
      if (this.plugin.settings.hotspotCategories.some(c => c.name === name)) {
        new Notice('热点管理：该分类已存在');
        return;
      }
      this.plugin.settings.hotspotCategories.push({ name, keywords: [], lastAnalyzedAt: null });
      await this.plugin.saveSettings();
      addInput.value = '';
      this.display();
    });

    // Category cards
    for (const cat of this.plugin.settings.hotspotCategories) {
      const catCard = hotspotBody.createEl('div');
      catCard.style.cssText =
        'margin:6px 16px;border-radius:8px;overflow:hidden;' +
        'border:1px solid var(--background-modifier-border);';

      // Category header row
      const catHeader = catCard.createEl('div');
      catHeader.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:8px;' +
        'padding:8px 12px;background:var(--background-secondary);' +
        'border-bottom:1px solid var(--background-modifier-border);';

      const catInfo = catHeader.createEl('div');
      catInfo.style.cssText = 'flex:1;min-width:0;';
      catInfo.createEl('span', { text: `🔥 ${cat.name}` }).style.cssText =
        'font-size:14px;font-weight:600;';
      catInfo.createEl('div', {
        text: cat.lastAnalyzedAt
          ? `上次分析：${new Date(cat.lastAnalyzedAt).toLocaleDateString('zh-CN')} · ${cat.keywords.length} 个关键词`
          : `${cat.keywords.length} 个关键词 · 未分析`,
      }).style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:2px;';

      const catBtns = catHeader.createEl('div');
      catBtns.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';

      const analyzeBtn = catBtns.createEl('button', { text: '立即分析' });
      analyzeBtn.style.cssText =
        'font-size:12px;padding:4px 12px;cursor:pointer;border-radius:4px;font-weight:600;' +
        'background:var(--interactive-accent);color:var(--text-on-accent);border:none;';
      analyzeBtn.onclick = () => this.plugin.hotspot.analyzeCategory(cat);

      const canAi = this.plugin.settings.enableAiClassify && !!this.plugin.settings.openaiApiKey;
      const suggestBtn = catBtns.createEl('button', { text: 'AI 推荐词' });
      suggestBtn.style.cssText =
        'font-size:12px;padding:4px 10px;cursor:pointer;border-radius:4px;border:none;' +
        (canAi
          ? 'background:var(--background-modifier-border);color:var(--text-normal);'
          : 'background:var(--background-modifier-border);color:var(--text-muted);cursor:not-allowed;');
      suggestBtn.title = canAi ? 'AI 自动推荐关键词（会替换现有关键词）' : '请先在「AI 分类」区块配置并启用 AI';
      suggestBtn.onclick = async () => {
        if (!canAi) { new Notice('热点管理：请先配置并启用 AI 分类'); return; }
        suggestBtn.textContent = '推荐中…';
        suggestBtn.disabled = true;
        try {
          const keywords = await suggestHotspotKeywords(
            cat.name,
            this.plugin.settings.openaiApiKey,
            this.plugin.settings.openaiBaseUrl,
            this.plugin.settings.openaiModel,
          );
          if (keywords.length) {
            cat.keywords = keywords;
            await this.plugin.saveSettings();
            this.display();
          } else {
            new Notice('热点管理：AI 未返回关键词，请检查 AI 配置');
            suggestBtn.textContent = 'AI 推荐词';
            suggestBtn.disabled = false;
          }
        } catch (e: any) {
          new Notice(`热点管理：AI 推荐失败 — ${e.message}`);
          suggestBtn.textContent = 'AI 推荐词';
          suggestBtn.disabled = false;
        }
      };

      const clearBtn = catBtns.createEl('button', { text: '清理数据' });
      clearBtn.style.cssText =
        'font-size:12px;padding:4px 10px;cursor:pointer;border-radius:4px;border:none;' +
        'background:var(--background-modifier-border);color:var(--text-muted);';
      clearBtn.title = '删除此分类下所有已抓取的帖子和报告，以便重新分析';
      clearBtn.onclick = async () => {
        const root = this.plugin.settings.rootFolder;
        const folderPath = normalizePath(`${root}/Hotspots/${cat.name}`);
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (folder instanceof TFolder) {
          // Delete media subfolders for each note in this category
          const mediaRoot = normalizePath(`${root}/Media`);
          for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md') {
              const mediaFolder = this.app.vault.getAbstractFileByPath(
                normalizePath(`${mediaRoot}/${child.basename}`),
              );
              if (mediaFolder instanceof TFolder) {
                await this.app.vault.trash(mediaFolder, false);
              }
            }
          }
          await this.app.vault.trash(folder, false);
          new Notice(`热点管理：已清理「${cat.name}」数据及媒体文件`);
        } else {
          new Notice(`热点管理：「${cat.name}」暂无数据`);
        }
        cat.lastAnalyzedAt = null;
        await this.plugin.saveSettings();
        this.display();
      };

      const delBtn = catBtns.createEl('button', { text: '×' });
      delBtn.style.cssText =
        'background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:18px;line-height:1;padding:0 2px;';
      delBtn.onclick = async () => {
        this.plugin.settings.hotspotCategories =
          this.plugin.settings.hotspotCategories.filter(c => c.name !== cat.name);
        await this.plugin.saveSettings();
        this.display();
      };

      // Keyword management area
      const kwArea = catCard.createEl('div');
      kwArea.style.cssText = 'padding:8px 12px 10px 12px;';
      kwArea.createEl('div', { text: '关键词（4–8 个，按回车添加）' }).style.cssText =
        'font-size:11px;color:var(--text-muted);margin-bottom:6px;';

      this.renderChips(
        kwArea,
        cat.keywords,
        async (kw) => {
          cat.keywords = cat.keywords.filter(k => k !== kw);
          await this.plugin.saveSettings();
          this.display();
        },
        async (kw) => {
          if (cat.keywords.length >= 8) {
            new Notice('热点管理：每个分类最多 8 个关键词');
            return;
          }
          if (!cat.keywords.includes(kw)) {
            cat.keywords.push(kw);
            await this.plugin.saveSettings();
            this.display();
          }
        },
        '输入关键词，按回车添加',
      );
    }

    if (this.plugin.settings.hotspotCategories.length === 0) {
      hotspotBody.createEl('div', { text: '暂无分类，请点击上方预设按钮或输入自定义分类名称' }).style.cssText =
        'padding:6px 16px 10px 16px;font-size:12px;color:var(--text-muted);';
    }

    // Global trigger button — always visible
    new Setting(hotspotBody)
      .setName('分析全部分类')
      .setDesc(
        '依次分析所有分类，每次搜索/获取详情间隔 30 秒–5 分钟。' +
        '帖子保存至 Hotspots/{分类}/，分析报告保存至 Hotspots/{分类}/报告/{YYYY-MM-DD}.md。',
      )
      .addButton(btn => btn
        .setButtonText('全部立即分析')
        .setCta()
        .onClick(() => this.plugin.analyzeAllHotspots()));
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
