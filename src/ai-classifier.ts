import { requestUrl } from 'obsidian';
import { log, logError } from './logger';

export async function classifyNote(
  title: string,
  desc: string,
  tagNames: string[],
  categories: string[],
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<string | null> {
  if (!categories.length || !apiKey || !baseUrl) return null;

  const tagsStr = tagNames.length ? tagNames.map(t => `#${t}`).join(' ') : '无';
  const content = `标题：${title}\n内容：${desc.slice(0, 500)}\n标签：${tagsStr}`;
  const categoriesStr = categories.join('\n');
  const userPrompt =
    `请根据以下内容和标签，从给定的分类列表中选择最合适的分类：\n\n内容：\n${content}` +
    `\n\n可用分类：\n${categoriesStr}` +
    `\n\n要求：\n1. 只返回分类名称，不要其他文字\n2. 必须从上述列表中选择一个\n\n分类结果：`;

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
            content: '你是一个专业的内容分类助手。请根据提供的内容和标签，从给定的分类列表中选择最合适的分类。',
          },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 50,
      }),
      throw: false,
    });

    if (resp.status !== 200) {
      logError('[AIClassifier] HTTP', resp.status, resp.text?.slice(0, 200));
      return null;
    }

    const result: string = resp.json?.choices?.[0]?.message?.content?.trim() ?? '';
    log('[AIClassifier] raw result:', result);

    const matched = categories.find(c => result === c) ?? categories.find(c => result.includes(c));
    if (matched) {
      log(`[AIClassifier] classified as: ${matched}`);
      return matched;
    }
    return null;
  } catch (e: any) {
    logError('[AIClassifier] Error:', e.message);
    return null;
  }
}

export async function generateAiTags(
  title: string,
  desc: string,
  existingTags: string[],
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<string[]> {
  if (!apiKey || !baseUrl) return [];

  const existing = existingTags.length ? existingTags.map(t => `#${t}`).join(' ') : '无';
  const userPrompt =
    `请为以下小红书笔记生成 3–6 个语义标签，用于知识库分类检索。\n\n` +
    `标题：${title}\n正文：${desc.slice(0, 600)}\n已有标签：${existing}\n\n` +
    `要求：\n` +
    `1. 只输出一个 JSON 数组，格式：["标签1", "标签2", ...]\n` +
    `2. 每个标签 2–8 个中文字，概念清晰，不重复已有标签\n` +
    `3. 优先选择主题领域、受众群体、内容类型等维度\n` +
    `4. 不要输出其他任何文字\n\n标签数组：`;

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
          { role: 'system', content: '你是一个专业的内容标签生成助手，只输出 JSON 数组，不输出其他内容。' },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 150,
        temperature: 0.3,
      }),
      throw: false,
    });

    if (resp.status !== 200) {
      logError('[AITagger] HTTP', resp.status, resp.text?.slice(0, 200));
      return [];
    }

    const raw: string = resp.json?.choices?.[0]?.message?.content?.trim() ?? '';
    log('[AITagger] raw:', raw);
    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((t: unknown) => String(t).trim()).filter(Boolean);
  } catch (e: any) {
    logError('[AITagger] Error:', e.message);
    return [];
  }
}

export async function testAiConfig(
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    log('[testAiConfig] URL:', url);
    log('[testAiConfig] Model:', model);

    const resp = await requestUrl({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: "Reply with just 'OK' to confirm." }],
        max_tokens: 10,
      }),
      throw: false,
    });

    log('[testAiConfig] Status:', resp.status);
    log('[testAiConfig] Response body:', resp.text?.slice(0, 200));

    if (resp.status === 200) {
      return { ok: true, message: '✅ AI 配置可用！' };
    }
    return { ok: false, message: `❌ HTTP ${resp.status}: ${resp.text?.slice(0, 100)}` };
  } catch (e: any) {
    logError('[testAiConfig] Error:', e.message);
    return { ok: false, message: `❌ ${e.message}` };
  }
}
