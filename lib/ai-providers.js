/**
 * AI Provider Library
 * Supports OpenAI, Google Gemini, Azure OpenAI, custom OpenAI-compatible APIs
 * v2: Single-item translation uses plain-text prompt (no [index] markers)
 */

const AIProviders = {
  getConfig(provider) {
    const configs = {
      openai: {
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
        defaultModel: 'gpt-4o-mini',
        maxTokens: 4096
      },
      gemini: {
        name: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        models: ['gemini-2.0-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash'],
        defaultModel: 'gemini-2.0-flash-lite',
        maxTokens: 8192
      },
      deepseek: {
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        defaultModel: 'deepseek-chat',
        maxTokens: 4096
      },
      custom: {
        name: 'Custom API',
        baseUrl: '',
        models: [],
        defaultModel: '',
        maxTokens: 4096
      }
    };
    return configs[provider] || configs.openai;
  },

  getLangName(targetLang) {
    const langNames = {
      'zh': 'Chinese',
      'zh-CN': 'Simplified Chinese',
      'zh-TW': 'Traditional Chinese',
      'en': 'English',
      'ja': 'Japanese',
      'ko': 'Korean',
      'fr': 'French',
      'de': 'German',
      'es': 'Spanish',
      'ru': 'Russian',
      'it': 'Italian',
      'pt': 'Portuguese',
      'ar': 'Arabic',
      'th': 'Thai',
      'vi': 'Vietnamese'
    };
    return langNames[targetLang] || targetLang;
  },

  buildBatchPrompt(texts, targetLang) {
    const targetName = this.getLangName(targetLang);
    const subtitlesText = texts.map((t, i) => `[${i}] ${t.replace(/\n/g, ' ')}`).join('\n');

    return `You are a professional subtitle translator. Translate the following subtitle lines to ${targetName}.
Rules:
1. Keep the meaning accurate and natural
2. Maintain the original tone and style
3. Keep each translation concise (suitable for subtitles)
4. Return ONLY the translations in the same format: [index] translated_text
5. Do not add explanations or notes
6. Translate line by line, preserving the [index] markers
7. Each input line is a complete subtitle; do not split or merge them

Subtitles to translate:
${subtitlesText}`;
  },

  buildSinglePrompt(text, targetLang) {
    const targetName = this.getLangName(targetLang);
    return `Translate the following subtitle to ${targetName}.
Rules:
1. Keep the meaning accurate and natural
2. Maintain the original tone and style
3. Keep it concise (suitable for subtitles)
4. Return ONLY the translation text, no explanations, no markdown, no quotes, no index numbers
5. Preserve line breaks if the original has multiple lines

Subtitle to translate:
${text}`;
  },

  parseBatchResponse(responseText) {
    const results = {};
    if (!responseText) return results;

    // Pattern 1: [0] text
    const regex1 = /^\[(\d+)\]\s*(.+)$/gm;
    let match;
    while ((match = regex1.exec(responseText)) !== null) {
      const idx = parseInt(match[1]);
      const text = match[2].trim();
      if (!isNaN(idx) && text) results[idx] = text;
    }
    if (Object.keys(results).length > 0) return results;

    // Pattern 2: numbered lines like "1. text" or "1) text"
    const regex2 = /^(?:\[(\d+)\]|(\d+)[.\)])[\s\t]*(.+)$/gm;
    while ((match = regex2.exec(responseText)) !== null) {
      const idx = parseInt(match[1] || match[2]);
      const text = match[3].trim();
      if (!isNaN(idx) && text) results[idx] = text;
    }
    if (Object.keys(results).length > 0) return results;

    // Pattern 3: line by line fallback
    const lines = responseText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let idx = 0;
    for (const line of lines) {
      if (/^(```|#|Note|Please|Here|Sure|Okay)/i.test(line)) continue;
      const clean = line.replace(/^\d+[.\)]\s*/, '').replace(/^[-*]\s*/, '').trim();
      if (clean && clean.length > 0 && clean.length < 300) {
        results[idx] = clean;
        idx++;
      }
      if (idx >= 30) break;
    }

    return results;
  },

  parseSingleResponse(responseText) {
    if (!responseText) return '';
    let text = responseText.trim();

    // Remove DeepSeek reasoning_content markers
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    text = text.replace(/---\nReasoning:[\s\S]*?---/g, '');

    // Remove markdown code blocks
    text = text.replace(/^```[\s\S]*?```/gm, '');

    // Remove [0] prefix if model still outputs it
    text = text.replace(/^\[0\]\s*/, '');

    // Remove surrounding quotes
    text = text.replace(/^["']|["']$/g, '');

    // Remove "Translation:" or similar prefixes
    text = text.replace(/^(Translation|翻译|译文)[\s:：]+/i, '');

    return text.trim();
  },

  async translateOpenAI({apiKey, baseUrl, model, texts, targetLang, signal, isSingle}) {
    const prompt = isSingle
      ? this.buildSinglePrompt(texts[0], targetLang)
      : this.buildBatchPrompt(texts, targetLang);

    // Create a new AbortController for timeout handling
    const controller = new AbortController();

    // Wire external signal to internal controller
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    // Timeout: 20s for single, 60s for batch (DeepSeek needs more time)
    const timeoutMs = isSingle ? 20000 : 60000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: 'You are a professional subtitle translator.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.3,
          max_tokens: isSingle ? 512 : Math.min(texts.length * 120, 4096)
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        // Special handling for 524 (Cloudflare Gateway Timeout)
        if (response.status === 524) {
          throw new Error('API 524: DeepSeek 服务器响应超时，请稍后重试或检查网络');
        }

        let errText = '';
        try {
          errText = await response.text();
        } catch (e) {}

        // Truncate overly long error messages (HTML error pages)
        if (errText.length > 200) {
          errText = errText.substring(0, 200) + '...';
        }

        throw new Error(`API Error ${response.status}${errText ? ': ' + errText : ''}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';

      if (isSingle) {
        const result = this.parseSingleResponse(content);
        console.log('[JDS] API single response:', result.substring(0, 120));
        return { 0: result };
      } else {
        console.log('[JDS] API batch response:', content.substring(0, 200));
        return this.parseBatchResponse(content);
      }
    } catch (err) {
      // Distinguish timeout from other errors
      if (err.name === 'AbortError') {
        throw new Error('请求超时（' + timeoutMs/1000 + '秒），服务器未响应');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  },

  async translateGemini({apiKey, baseUrl, model, texts, targetLang, signal, isSingle}) {
    const prompt = isSingle
      ? this.buildSinglePrompt(texts[0], targetLang)
      : this.buildBatchPrompt(texts, targetLang);
    const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`;

    // Create a new AbortController for timeout handling
    const controller = new AbortController();

    // Wire external signal to internal controller
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    // Timeout: 20s for single, 60s for batch
    const timeoutMs = isSingle ? 20000 : 60000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: isSingle ? 512 : Math.min(texts.length * 120, 8192)
          }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        let errText = '';
        try {
          errText = await response.text();
        } catch (e) {}
        if (errText.length > 200) {
          errText = errText.substring(0, 200) + '...';
        }
        throw new Error(`Gemini API Error ${response.status}${errText ? ': ' + errText : ''}`);
      }

      const data = await response.json();
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      if (isSingle) {
        const result = this.parseSingleResponse(content);
        console.log('[JDS] Gemini single response:', result.substring(0, 120));
        return { 0: result };
      } else {
        console.log('[JDS] Gemini batch response:', content.substring(0, 200));
        return this.parseBatchResponse(content);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('请求超时（' + timeoutMs/1000 + '秒），服务器未响应');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  },

  async translate(settings, texts, signal) {
    const { provider, apiKey, apiUrl, model, targetLang } = settings;
    const config = this.getConfig(provider);
    const baseUrl = apiUrl || config.baseUrl;
    const useModel = model || config.defaultModel;

    if (!apiKey) throw new Error('API Key not configured');
    if (!texts || texts.length === 0) return {};

    const isSingle = texts.length === 1;
    const params = { apiKey, baseUrl, model: useModel, texts, targetLang, signal, isSingle };

    if (provider === 'gemini') {
      return await this.translateGemini(params);
    } else {
      return await this.translateOpenAI(params);
    }
  }
};

if (typeof window !== 'undefined') {
  window.AIProviders = AIProviders;
}
