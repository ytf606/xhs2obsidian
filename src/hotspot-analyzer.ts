import { requestUrl } from 'obsidian';
import { XhsNote } from './types';
import { log, logError } from './logger';

export interface HotspotNoteAnalysis {
  noteId: string;
  title: string;
  url: string;
  likedCount: string;
  commentCount: string;
  keyword: string;
  titleFormula: string;
  openingHook: string;
  contentStructure: string;
  emotionalTriggers: string;
  visualStyle: string;
  interactionScript: string;
  conversionHook: string;
}

export function parseLikes(s: string): number {
  if (!s) return 0;
  const str = s.trim();
  if (str.endsWith('万')) return Math.round(parseFloat(str) * 10000);
  if (str.endsWith('k') || str.endsWith('K')) return Math.round(parseFloat(str) * 1000);
  return parseInt(str) || 0;
}

export async function suggestHotspotKeywords(
  categoryName: string,
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<string[]> {
  if (!apiKey || !baseUrl) return [];

  const prompt =
    `请为小红书热点分析生成 4–8 个搜索关键词，分类名称为：「${categoryName}」。\n\n` +
    `要求：\n` +
    `1. 只输出一个 JSON 数组，格式：["关键词1", "关键词2", ...]\n` +
    `2. 关键词须是用户在小红书实际搜索的词语，2–8 个字，贴近真实搜索习惯\n` +
    `3. 覆盖该分类下不同细分方向，便于抓取多样化热点内容\n` +
    `4. 不要输出其他任何文字\n\n关键词数组：`;

  try {
    const resp = await requestUrl({
      url: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是一位熟悉小红书平台的内容运营专家，擅长预判热门搜索关键词。只输出 JSON 数组，不输出其他内容。' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 200,
        temperature: 0.5,
      }),
      throw: false,
    });

    if (resp.status !== 200) {
      log('[HotspotKeyword] HTTP ' + resp.status);
      return [];
    }

    const raw: string = resp.json?.choices?.[0]?.message?.content?.trim() ?? '';
    log('[HotspotKeyword] raw:', raw);
    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).map(k => String(k).trim()).filter(Boolean).slice(0, 8);
  } catch (e: any) {
    log('[HotspotKeyword] error: ' + e.message);
    return [];
  }
}

export async function analyzeHotspotNote(
  note: XhsNote,
  keyword: string,
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<HotspotNoteAnalysis | null> {
  if (!apiKey || !baseUrl) return null;

  const noteUrl = `https://www.xiaohongshu.com/explore/${note.id}?xsec_token=${encodeURIComponent(note.xsecToken)}&xsec_source=pc_feed`;
  const prompt = `你是一位专业的小红书内容策略分析师。请对以下小红书笔记进行深度分析，严格按照 JSON 格式输出，不要包含任何其他文字。

笔记信息：
标题：${note.title || '（无标题）'}
正文：${note.desc.slice(0, 800) || '（无正文）'}
点赞：${note.interactInfo.likedCount} | 评论：${note.interactInfo.commentCount} | 转发：${note.interactInfo.shareCount}
标签：${note.tagList.map(t => t.name).join('、') || '无'}

请输出以下 JSON（所有字段均为纯文字，不超过 150 字）：
{
  "titleFormula": "标题的构成公式与套路，如：痛点+解决方案、数字+结果、疑问式标题等",
  "openingHook": "开头的吸引手法，前两句的钩子策略",
  "contentStructure": "内容的整体结构框架，如：问题-分析-方案-行动，或悬念-展开-高潮-收尾",
  "emotionalTriggers": "核心情绪触发点，利用了哪些情绪共鸣（焦虑、好奇、认同、向往等）",
  "visualStyle": "推测或分析视觉/排版风格偏好（如封面风格、文字排版、图片色调）",
  "interactionScript": "引导互动的话术策略，如求赞/求评论/提问引导等",
  "conversionHook": "转化与留存钩子，如引导关注、引导私信、留下悬念等"
}`;

  try {
    const resp = await requestUrl({
      url: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: '你是专业的小红书内容策略分析师，擅长拆解爆款内容结构。输出时只返回 JSON，不要包含 markdown 代码块标记。',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 800,
        temperature: 0.3,
      }),
      throw: false,
    });

    if (resp.status !== 200) {
      logError('[HotspotAnalyzer] HTTP', resp.status, resp.text?.slice(0, 200));
      return null;
    }

    const raw: string = resp.json?.choices?.[0]?.message?.content?.trim() ?? '';
    log('[HotspotAnalyzer] raw:', raw.slice(0, 400));

    // Strip possible ```json ... ``` wrapper
    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      logError('[HotspotAnalyzer] JSON parse failed for note', note.id);
      return null;
    }

    return {
      noteId: note.id,
      title: note.title || note.desc.slice(0, 40) || note.id,
      url: noteUrl,
      likedCount: note.interactInfo.likedCount,
      commentCount: note.interactInfo.commentCount,
      keyword,
      titleFormula: parsed.titleFormula ?? '',
      openingHook: parsed.openingHook ?? '',
      contentStructure: parsed.contentStructure ?? '',
      emotionalTriggers: parsed.emotionalTriggers ?? '',
      visualStyle: parsed.visualStyle ?? '',
      interactionScript: parsed.interactionScript ?? '',
      conversionHook: parsed.conversionHook ?? '',
    };
  } catch (e: any) {
    logError('[HotspotAnalyzer] Error:', e.message);
    return null;
  }
}
