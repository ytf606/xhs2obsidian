import { Notice, Vault, normalizePath } from 'obsidian';
import { RedbookPullSettings, HotspotCategory, XhsNote } from './types';
import { XhsApi } from './xhs-api';
import { VaultWriter } from './vault-writer';
import { HotspotNoteAnalysis, analyzeHotspotNote, parseLikes } from './hotspot-analyzer';
import { generateAiTags } from './ai-classifier';
import { log, logError } from './logger';

const KEYWORD_TOP_N = 6;
const TOTAL_KEEP = 30;
const ANALYZE_TOP_N = 15;

function randomSleep(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}

function dateStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, '_').trim().slice(0, 80) || 'untitled';
}

function noteUrl(note: XhsNote): string {
  return `https://www.xiaohongshu.com/explore/${note.id}?xsec_token=${encodeURIComponent(note.xsecToken)}&xsec_source=pc_feed`;
}

function renderReport(
  category: HotspotCategory,
  top30: Array<{ note: XhsNote; keyword: string }>,
  analyses: Array<HotspotNoteAnalysis | null>,
): string {
  const today = dateStr();
  const keywordsYaml = `[${category.keywords.map(k => `"${k}"`).join(', ')}]`;

  const frontmatter = [
    '---',
    `category: "${category.name}"`,
    `date: "${today}"`,
    `keywords: ${keywordsYaml}`,
    `analyzedAt: "${nowStr()}"`,
    `noteCount: ${top30.length}`,
    '---',
  ].join('\n');

  const lines: string[] = [
    frontmatter,
    '',
    `# ${category.name} 热点分析报告 · ${today}`,
    '',
    '## 数据汇总（点赞排名前 30）',
    '',
    '| 排名 | 标题 | 点赞 | 评论 | 来源关键词 |',
    '|:----:|------|-----:|-----:|-----------|',
  ];

  top30.forEach(({ note, keyword }, i) => {
    const title = `[${note.title || note.id}](${noteUrl(note)})`;
    lines.push(
      `| ${i + 1} | ${title} | ${note.interactInfo.likedCount} | ${note.interactInfo.commentCount} | ${keyword} |`,
    );
  });

  lines.push('', '---', '', `## 深度分析（前 ${Math.min(ANALYZE_TOP_N, top30.length)} 条）`, '');

  for (let i = 0; i < Math.min(ANALYZE_TOP_N, top30.length); i++) {
    const { note, keyword } = top30[i];
    const analysis = analyses[i];
    const title = note.title || note.id;
    const url = noteUrl(note);

    lines.push(`### ${i + 1}. [${title}](${url})`);
    lines.push('');
    lines.push(
      `**基础数据** 点赞 ${note.interactInfo.likedCount} · 评论 ${note.interactInfo.commentCount} · 转发 ${note.interactInfo.shareCount} · 来源关键词「${keyword}」`,
    );
    lines.push('');

    if (note.desc) {
      lines.push('**正文摘要**');
      lines.push('');
      lines.push(`> ${note.desc.slice(0, 200).replace(/\n/g, '\n> ')}${note.desc.length > 200 ? '…' : ''}`);
      lines.push('');
    }

    if (analysis) {
      const dims: Array<[string, string]> = [
        ['标题公式', analysis.titleFormula],
        ['开头钩子', analysis.openingHook],
        ['内容结构', analysis.contentStructure],
        ['情绪触发点', analysis.emotionalTriggers],
        ['视觉风格', analysis.visualStyle],
        ['互动话术', analysis.interactionScript],
        ['转化钩子', analysis.conversionHook],
      ];
      for (const [dim, val] of dims) {
        lines.push(`**${dim}**`);
        lines.push('');
        lines.push(val || '—');
        lines.push('');
      }
    } else {
      lines.push('*（AI 分析失败或未启用）*');
      lines.push('');
    }

    lines.push('---', '');
  }

  return lines.join('\n');
}

export class HotspotEngine {
  private running = false;

  constructor(
    private settings: RedbookPullSettings,
    private api: XhsApi,
    private vault: Vault,
    private writer: VaultWriter,
    private saveData: () => Promise<void>,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  async analyzeCategory(category: HotspotCategory): Promise<void> {
    if (this.running) {
      new Notice('热点管理：分析正在进行中，请稍候');
      return;
    }
    if (!this.settings.a1Cookie) {
      new Notice('热点管理：请先登录小红书');
      return;
    }
    if (!category.keywords.length) {
      new Notice(`热点管理：请先为「${category.name}」添加关键词`);
      return;
    }

    this.running = true;
    new Notice(`热点管理：开始分析「${category.name}」，共 ${category.keywords.length} 个关键词…`);

    try {
      // Step 1: Collect top 6 notes per keyword
      const collected: Map<string, { note: XhsNote; keyword: string }> = new Map();

      for (let ki = 0; ki < category.keywords.length; ki++) {
        const keyword = category.keywords[ki];
        new Notice(`热点管理：搜索关键词「${keyword}」（${ki + 1}/${category.keywords.length}）…`);

        try {
          const { items } = await this.api.searchNotes(keyword, 1, 'popularity_descending');
          const top6 = items.slice(0, KEYWORD_TOP_N);
          for (const note of top6) {
            if (!collected.has(note.id)) {
              collected.set(note.id, { note, keyword });
            }
          }
          log(`[HotspotEngine] keyword="${keyword}" fetched ${top6.length} notes`);
        } catch (e: any) {
          new Notice(`热点管理：关键词「${keyword}」搜索失败 — ${e.message}`);
          logError(`[HotspotEngine] search error for "${keyword}":`, e.message);
        }

        if (ki < category.keywords.length - 1) {
          await randomSleep(3000, 10000); // throttle already enforces 30s floor
        }
      }

      if (collected.size === 0) {
        new Notice(`热点管理：「${category.name}」未获取到任何内容`);
        return;
      }

      // Step 2: Deduplicate (already done via Map), sort by likes, keep top 30
      const ranked = [...collected.values()]
        .sort((a, b) => parseLikes(b.note.interactInfo.likedCount) - parseLikes(a.note.interactInfo.likedCount))
        .slice(0, TOTAL_KEEP);

      new Notice(`热点管理：去重后共 ${ranked.length} 条，开始获取详情…`);

      // Step 3: Fetch note detail for all top 30 (with 30s-5min delay)
      for (let i = 0; i < ranked.length; i++) {
        const entry = ranked[i];
        try {
          const detail = await this.api.fetchNoteDetail(entry.note.id, entry.note.xsecToken);
          if (detail) entry.note = detail;
          log(`[HotspotEngine] detail fetched ${i + 1}/${ranked.length}: ${entry.note.id}`);
        } catch (e: any) {
          logError(`[HotspotEngine] fetchNoteDetail error (${entry.note.id}):`, e.message);
        }
        if (i < ranked.length - 1) {
          await randomSleep(3000, 8000); // throttle already enforces 30s floor
        }
      }

      const canAi = this.settings.enableAiClassify && !!this.settings.openaiApiKey;

      // Step 4: Write all top 30 notes to vault under Hotspots/{category}/
      new Notice(`热点管理：保存 ${ranked.length} 篇帖子到 ${this.writer.root}/Hotspots/${sanitize(category.name)}/…`);
      for (const { note } of ranked) {
        try {
          let aiTags: string[] = [];
          if (canAi && this.settings.enableAiTagging) {
            try {
              aiTags = await generateAiTags(
                note.title || note.desc.slice(0, 40),
                note.desc,
                note.tagList.map(t => t.name),
                this.settings.openaiApiKey,
                this.settings.openaiBaseUrl,
                this.settings.openaiModel,
              );
            } catch { /* non-fatal */ }
          }
          // 'Hotspots' is not in FOLDER_MAP so vault-writer uses it as-is → Hotspots/{category}/{title}.md
          await this.writer.write(note, 'Hotspots', category.name, [], aiTags);
        } catch (e: any) {
          logError(`[HotspotEngine] write note error (${note.id}):`, e.message);
        }
      }

      // Step 5: AI deep analysis for top 15
      const analyses: Array<HotspotNoteAnalysis | null> = [];
      const analyzeCount = Math.min(ANALYZE_TOP_N, ranked.length);

      if (canAi) {
        new Notice(`热点管理：开始 AI 深度分析前 ${analyzeCount} 条…`);
        for (let i = 0; i < analyzeCount; i++) {
          const { note, keyword } = ranked[i];
          try {
            const result = await analyzeHotspotNote(
              note,
              keyword,
              this.settings.openaiApiKey,
              this.settings.openaiBaseUrl,
              this.settings.openaiModel,
            );
            analyses.push(result);
            log(`[HotspotEngine] analyzed ${i + 1}/${analyzeCount}: ${note.id}`);
          } catch (e: any) {
            logError(`[HotspotEngine] analyze error (${note.id}):`, e.message);
            analyses.push(null);
          }
          if (i < analyzeCount - 1) await randomSleep(1000, 3000);
        }
      } else {
        for (let i = 0; i < analyzeCount; i++) analyses.push(null);
        new Notice('热点管理：未配置 AI，跳过深度分析（可在 AI 分类设置中配置）');
      }

      // Step 6: Write analysis report to vault
      const report = renderReport(category, ranked, analyses);
      await this.writeReport(category.name, report);

      // Update lastAnalyzedAt
      const cat = this.settings.hotspotCategories.find(c => c.name === category.name);
      if (cat) {
        cat.lastAnalyzedAt = new Date().toISOString();
        await this.saveData();
      }

      new Notice(`热点管理：「${category.name}」完成，帖子→Hotspots/${sanitize(category.name)}/，报告→…/报告/`);
    } catch (e: any) {
      new Notice(`热点管理：「${category.name}」出错 — ${e.message}`);
      logError('[HotspotEngine] analyzeCategory error:', e);
    } finally {
      this.running = false;
    }
  }

  private async writeReport(categoryName: string, content: string): Promise<void> {
    const root = this.writer.root;
    const dir = normalizePath(`${root}/Hotspots/${sanitize(categoryName)}/报告`);
    await this.writer.ensureDir(dir);

    const fileName = `${dateStr()}.md`;
    const filePath = normalizePath(`${dir}/${fileName}`);

    if (await this.vault.adapter.exists(filePath)) {
      await this.vault.adapter.write(filePath, content);
    } else {
      await this.vault.create(filePath, content);
    }
    log(`[HotspotEngine] report written to ${filePath}`);
  }
}
