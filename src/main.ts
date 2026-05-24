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

    // ── 登录状态 ──────────────────────────────────────────────
    const isLoggedIn = !!this.plugin.settings.a1Cookie;
    const displayName = this.plugin.settings.userName;
    const loginSetting = new Setting(containerEl)
      .setName('小红书登录状态')
      .setDesc(isLoggedIn
        ? (displayName ? `已登录：${displayName}` : '已登录')
        : '未登录');

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

    // ── 各目标同步数量 ─────────────────────────────────────────
    for (const [key, label] of Object.entries(SYNC_TARGET_LABELS) as [SyncTarget, string][]) {
      const count = this.plugin.settings.syncedIds[key]?.length ?? 0;
      const allSynced = this.plugin.settings.allSynced[key];

      const s = new Setting(containerEl)
        .setName(`${label}：${count} 条`);

      if (allSynced) {
        s.setDesc('历史数据同步完成，开始增量同步');
        s.descEl.style.color = 'var(--color-green)';
      }
    }

    // ── 清除缓存 ──────────────────────────────────────────────
    new Setting(containerEl)
      .setName('清除同步缓存')
      .setDesc('重置已同步记录，不会删除已有文件，重新同步时会覆盖更新')
      .addButton(btn => btn
        .setButtonText('清除缓存并重新同步')
        .setWarning()
        .onClick(async () => {
          for (const key of Object.keys(SYNC_TARGET_LABELS) as SyncTarget[]) {
            this.plugin.settings.syncCursors[key] = null;
            this.plugin.settings.syncedIds[key] = [];
            this.plugin.settings.allSynced[key] = false;
          }
          await this.plugin.saveSettings();
          new Notice('Redbook Pull：同步缓存已清除');
          this.display();
        }));

    // ── Vault 配置 ────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Vault 配置' });

    new Setting(containerEl)
      .setName('根目录名')
      .setDesc('同步内容存储在 Vault 中的此目录下')
      .addText(text => text
        .setPlaceholder('RedNote')
        .setValue(this.plugin.settings.rootFolder)
        .onChange(async v => {
          this.plugin.settings.rootFolder = v.trim() || 'RedNote';
          await this.plugin.saveSettings();
          this.plugin.rebuildEngine();
        }));

    // ── 同步配置 ──────────────────────────────────────────────
    containerEl.createEl('h3', { text: '同步配置' });

    new Setting(containerEl)
      .setName('定时自动同步')
      .setDesc('开启后按设定间隔自动同步，遇到限流或登录失效会自动关闭')
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
        .setDesc('每隔多少分钟自动同步一次（最小 5 分钟，避免触发小红书频率限制）')
        .addText(text => text
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async v => {
            const n = parseInt(v);
            if (!isNaN(n) && n >= 5) {
              this.plugin.settings.syncIntervalMinutes = n;
              await this.plugin.saveSettings();
              this.plugin.startAutoSync();
            }
          }));
    }

    new Setting(containerEl)
      .setName('每批同步数量')
      .setDesc('每次同步的帖子数量（5-10 之间，避免触发小红书频率限制）')
      .addText(text => text
        .setValue(String(this.plugin.settings.syncBatchSize))
        .onChange(async v => {
          const n = parseInt(v);
          if (!isNaN(n) && n >= 1 && n <= 20) {
            this.plugin.settings.syncBatchSize = n;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('同步内容')
      .setDesc('同一时间只同步一种类型，减少请求量')
      .addDropdown(dd => {
        for (const [key, label] of Object.entries(SYNC_TARGET_LABELS)) {
          dd.addOption(key, label);
        }
        dd.setValue(this.plugin.settings.syncTarget);
        dd.onChange(async v => {
          this.plugin.settings.syncTarget = v as SyncTarget;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('同步标签')
      .setDesc('将小红书话题标签写入笔记 frontmatter')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncTags)
        .onChange(async v => {
          this.plugin.settings.syncTags = v;
          await this.plugin.saveSettings();
          this.plugin.rebuildEngine();
        }));

    new Setting(containerEl)
      .setName('同步专辑（收藏）')
      .setDesc('先按专辑分目录同步收藏，每个专辑一个子目录；专辑同步完成后再同步未分类的收藏')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncAlbums)
        .onChange(async v => {
          this.plugin.settings.syncAlbums = v;
          await this.plugin.saveSettings();
        }));

    // ── AI 分类 ────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'AI 分类（可选）' });

    new Setting(containerEl)
      .setName('启用 AI 分类')
      .setDesc('同步时用 AI 自动将笔记归入指定分类子目录')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableAiClassify)
        .onChange(async v => {
          this.plugin.settings.enableAiClassify = v;
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.enableAiClassify) {
      new Setting(containerEl)
        .setName('API Key')
        .addText(text => text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.openaiApiKey)
          .onChange(async v => {
            this.plugin.settings.openaiApiKey = v.trim();
            await this.plugin.saveSettings();
          }))
        .then(s => { (s.controlEl.querySelector('input') as HTMLInputElement).type = 'password'; });

      new Setting(containerEl)
        .setName('API Base URL')
        .setDesc('OpenAI 兼容接口地址，必须包含 /v1，例如 https://api.openai.com/v1、https://openrouter.ai/api/v1')
        .addText(text => text
          .setPlaceholder('https://api.openai.com/v1')
          .setValue(this.plugin.settings.openaiBaseUrl)
          .onChange(async v => {
            this.plugin.settings.openaiBaseUrl = v.trim();
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName('模型')
        .addText(text => text
          .setPlaceholder('gpt-4o-mini')
          .setValue(this.plugin.settings.openaiModel)
          .onChange(async v => {
            this.plugin.settings.openaiModel = v.trim();
            await this.plugin.saveSettings();
          }));

      const testSetting = new Setting(containerEl)
        .setName('测试 AI 配置')
        .setDesc('发送一个测试请求验证 API Key 和模型是否能用')
        .addButton(btn => btn
          .setButtonText('测试连接')
          .onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText('测试中...');
            const { ok, message } = await testAiConfig(
              this.plugin.settings.openaiApiKey,
              this.plugin.settings.openaiBaseUrl,
              this.plugin.settings.openaiModel,
            );
            btn.setDisabled(false);
            btn.setButtonText('测试连接');
            testSetting.setDesc(message);
            testSetting.descEl.style.color = ok ? 'var(--color-green)' : 'var(--text-error)';
          }));
    }

    // 分类列表（启用时显示）
    if (this.plugin.settings.enableAiClassify) {
      const catSetting = new Setting(containerEl)
        .setName('分类列表')
        .setDesc('输入分类名后按回车添加，点击 × 删除，或从专辑目录一键加载')
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
            if (added) new Notice(`Redbook Pull：已加载 ${added} 个分类`);
            this.display();
          }));

      // Chips row
      const chipsEl = containerEl.createEl('div');
      chipsEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:4px 0 8px 0;';
      for (const cat of this.plugin.settings.aiCategories) {
        const chip = chipsEl.createEl('span');
        chip.style.cssText =
          'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;' +
          'background:var(--background-modifier-border);font-size:12px;';
        chip.createSpan({ text: cat });
        const rm = chip.createEl('button', { text: '×' });
        rm.style.cssText =
          'background:none;border:none;cursor:pointer;padding:0 0 0 2px;' +
          'color:var(--text-muted);font-size:14px;line-height:1;';
        rm.onclick = async () => {
          this.plugin.settings.aiCategories =
            this.plugin.settings.aiCategories.filter(c => c !== cat);
          await this.plugin.saveSettings();
          this.display();
        };
      }

      // Input for new category
      const inputEl = containerEl.createEl('input') as HTMLInputElement;
      inputEl.type = 'text';
      inputEl.placeholder = '输入分类名，按回车添加';
      inputEl.style.cssText =
        'width:100%;padding:6px 10px;border:1px solid var(--background-modifier-border);' +
        'border-radius:4px;background:var(--background-primary);color:var(--text-normal);' +
        'font-size:14px;box-sizing:border-box;margin-bottom:8px;';
      inputEl.addEventListener('keydown', async (e: KeyboardEvent) => {
        if (e.key !== 'Enter') return;
        const val = inputEl.value.trim();
        if (val && !this.plugin.settings.aiCategories.includes(val)) {
          this.plugin.settings.aiCategories.push(val);
          await this.plugin.saveSettings();
          this.display();
        }
      });
    }

    // ── 关键词搜索 ─────────────────────────────────────────────
    containerEl.createEl('h3', { text: '关键词搜索' });

    new Setting(containerEl)
      .setName('立即执行搜索同步')
      .setDesc('重置各关键词同步状态后立即拉取，已下载内容不会重复同步')
      .addButton(btn => btn
        .setButtonText('立即拉取')
        .setCta()
        .onClick(async () => {
          for (const kw of this.plugin.settings.searchKeywords) {
            this.plugin.settings.searchAllSynced[kw] = false;
            this.plugin.settings.searchPages[kw] = 1;
          }
          await this.plugin.saveSettings();
          this.plugin.engine.syncSearch();
        }));

    // 每个关键词的同步状态
    for (const kw of this.plugin.settings.searchKeywords) {
      const count = this.plugin.settings.searchedNoteIds[kw]?.length ?? 0;
      const allDone = this.plugin.settings.searchAllSynced[kw];
      const s = new Setting(containerEl)
        .setName(`「${kw}」：${count} 篇`)
        .addButton(btn => btn
          .setButtonText('重置')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.searchPages[kw] = 1;
            this.plugin.settings.searchedNoteIds[kw] = [];
            this.plugin.settings.searchAllSynced[kw] = false;
            await this.plugin.saveSettings();
            this.display();
          }));
      if (allDone) {
        s.setDesc('已全部同步');
        s.descEl.style.color = 'var(--color-green)';
      }
    }

    // 关键词输入区
    new Setting(containerEl)
      .setName('关键词列表')
      .setDesc('输入关键词按回车添加，点击 × 删除');

    const kwChipsEl = containerEl.createEl('div');
    kwChipsEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:4px 0 8px 0;';
    for (const kw of this.plugin.settings.searchKeywords) {
      const chip = kwChipsEl.createEl('span');
      chip.style.cssText =
        'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;' +
        'background:var(--background-modifier-border);font-size:12px;';
      chip.createSpan({ text: kw });
      const rm = chip.createEl('button', { text: '×' });
      rm.style.cssText =
        'background:none;border:none;cursor:pointer;padding:0 0 0 2px;' +
        'color:var(--text-muted);font-size:14px;line-height:1;';
      rm.onclick = async () => {
        this.plugin.settings.searchKeywords =
          this.plugin.settings.searchKeywords.filter(k => k !== kw);
        await this.plugin.saveSettings();
        this.display();
      };
    }

    const kwInputEl = containerEl.createEl('input') as HTMLInputElement;
    kwInputEl.type = 'text';
    kwInputEl.placeholder = '输入关键词，按回车添加';
    kwInputEl.style.cssText =
      'width:100%;padding:6px 10px;border:1px solid var(--background-modifier-border);' +
      'border-radius:4px;background:var(--background-primary);color:var(--text-normal);' +
      'font-size:14px;box-sizing:border-box;margin-bottom:8px;';
    kwInputEl.addEventListener('keydown', async (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const val = kwInputEl.value.trim();
      if (val && !this.plugin.settings.searchKeywords.includes(val)) {
        this.plugin.settings.searchKeywords.push(val);
        await this.plugin.saveSettings();
        this.display();
      }
    });

    new Setting(containerEl)
      .setName('排序依据')
      .addDropdown(dd => {
        for (const [key, label] of Object.entries(SEARCH_SORT_LABELS)) {
          dd.addOption(key, label);
        }
        dd.setValue(this.plugin.settings.searchSort);
        dd.onChange(async v => {
          this.plugin.settings.searchSort = v as SearchSort;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('笔记类型')
      .addDropdown(dd => {
        for (const v of ['不限', '视频', '图文'] as SearchNoteType[]) dd.addOption(v, v);
        dd.setValue(this.plugin.settings.searchNoteType);
        dd.onChange(async v => {
          this.plugin.settings.searchNoteType = v as SearchNoteType;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('发布时间')
      .addDropdown(dd => {
        for (const v of ['不限', '一天内', '一周内', '半年内'] as SearchTimeFilter[]) dd.addOption(v, v);
        dd.setValue(this.plugin.settings.searchTimeFilter);
        dd.onChange(async v => {
          this.plugin.settings.searchTimeFilter = v as SearchTimeFilter;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('搜索范围')
      .addDropdown(dd => {
        for (const v of ['不限', '已看过', '未看过', '已关注'] as SearchRangeFilter[]) dd.addOption(v, v);
        dd.setValue(this.plugin.settings.searchRangeFilter);
        dd.onChange(async v => {
          this.plugin.settings.searchRangeFilter = v as SearchRangeFilter;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('位置距离')
      .addDropdown(dd => {
        for (const v of ['不限', '同城', '附近'] as SearchPosFilter[]) dd.addOption(v, v);
        dd.setValue(this.plugin.settings.searchPosFilter);
        dd.onChange(async v => {
          this.plugin.settings.searchPosFilter = v as SearchPosFilter;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('每次搜索条数')
      .setDesc('每次同步周期最多写入的笔记数（API 固定每页 20 条，设 5 只取前 5 条，设 30 则跨两页取 10+20）')
      .addText(text => text
        .setValue(String(this.plugin.settings.searchBatchSize))
        .onChange(async v => {
          const n = parseInt(v);
          if (!isNaN(n) && n >= 1 && n <= 100) {
            this.plugin.settings.searchBatchSize = n;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('定时自动搜索')
      .setDesc('按设定间隔自动执行关键词搜索')
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
        .addText(text => text
          .setValue(String(this.plugin.settings.searchIntervalMinutes))
          .onChange(async v => {
            const n = parseInt(v);
            if (!isNaN(n) && n >= 30) {
              this.plugin.settings.searchIntervalMinutes = n;
              await this.plugin.saveSettings();
              this.plugin.startAutoSearch();
            }
          }));
    }
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
