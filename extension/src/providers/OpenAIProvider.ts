import { StreamCallbacks, UsageResult, ImageAttachment, getModel } from '../types';

const VISION_MODELS = new Set([
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
]);

export class OpenAIProvider {
  private readonly baseUrl: string;

  constructor(private apiKey: string, baseUrl = 'https://api.openai.com') {
    this.baseUrl = baseUrl;
  }

  async chat(
    messages: { role: 'user' | 'assistant' | 'system'; content: string; image?: ImageAttachment }[],
    model: string,
    callbacks: StreamCallbacks
  ): Promise<void> {
    const supportsVision = VISION_MODELS.has(model);
    const apiMessages = messages.map(msg => ({
      role: msg.role,
      content: (msg.image && supportsVision)
        ? [
            { type: 'image_url', image_url: { url: `data:${msg.image.mimeType};base64,${msg.image.base64}` } },
            { type: 'text', text: msg.content || 'Analizza questa immagine' }
          ]
        : (msg.content || '')
    }));

    const body = JSON.stringify({ model, messages: apiMessages, stream: true, stream_options: { include_usage: true } });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: callbacks.signal,
      });
    } catch (e: unknown) {
      const err = e as Error;
      if (err.name === 'AbortError') return;
      callbacks.onError(`Connection error: ${err.message}`);
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      callbacks.onError(`OpenAI API error ${response.status}: ${text}`);
      return;
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let inputTokens = 0;
    let outputTokens = 0;
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
            const delta = event.choices?.[0]?.delta?.content;
            if (delta) callbacks.onChunk(delta);
            if (event.usage) {
              inputTokens = event.usage.prompt_tokens || 0;
              outputTokens = event.usage.completion_tokens || 0;
            }
          } catch {
            // ignore parse errors in SSE stream
          }
        }
      }
    } catch (e: unknown) {
      const err = e as Error;
      if (err.name !== 'AbortError') {
        callbacks.onError(`Stream error: ${err.message}`);
        return;
      }
    } finally {
      reader.releaseLock();
    }

    const modelInfo = getModel(model);
    const cost = modelInfo
      ? (inputTokens * modelInfo.inputCostPer1M + outputTokens * modelInfo.outputCostPer1M) / 1_000_000
      : 0;

    const usage: UsageResult = {
      inputTokens,
      outputTokens,
      model,
      provider: 'groq',
      estimatedCost: cost
    };

    callbacks.onEnd(usage);
  }
}
