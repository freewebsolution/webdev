import { StreamCallbacks, UsageResult } from '../types';
import { OpenAIProvider } from './OpenAIProvider';

export class GroqProvider {
  private inner: OpenAIProvider;

  constructor(apiKey: string) {
    this.inner = new OpenAIProvider(apiKey, 'https://api.groq.com/openai');
  }

  async chat(
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
    model: string,
    callbacks: StreamCallbacks
  ): Promise<void> {
    // Groq uses OpenAI-compatible API but override provider in onEnd
    const originalOnEnd = callbacks.onEnd;
    const wrapped: StreamCallbacks = {
      ...callbacks,
      onEnd: (usage: UsageResult) => originalOnEnd({ ...usage, provider: 'groq', estimatedCost: 0 })
    };
    return this.inner.chat(messages, model, wrapped);
  }
}
