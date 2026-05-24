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
