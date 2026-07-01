export type ProviderType = 'groq';

export interface ImageAttachment {
  base64: string;
  mimeType: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderType;
  contextWindow: number;
  inputCostPer1M: number;
  outputCostPer1M: number;
  free: boolean;
}

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  onEnd: (usage: UsageResult) => void;
  onError: (error: string) => void;
  signal: AbortSignal;
}

export interface UsageResult {
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: ProviderType;
  estimatedCost: number;
}

export interface WeeklyStats {
  weekStart: string;
  providers: Record<string, ProviderStats>;
}

export interface ProviderStats {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  calls: number;
}

export const MODELS: ModelInfo[] = [
  // Groq — General
  { id: 'llama-3.3-70b-versatile',                       name: 'LLaMA 3.3 70B',            provider: 'groq', contextWindow: 131072, inputCostPer1M: 0, outputCostPer1M: 0, free: true },
  { id: 'llama-3.1-8b-instant',                          name: 'LLaMA 3.1 8B',             provider: 'groq', contextWindow: 131072, inputCostPer1M: 0, outputCostPer1M: 0, free: true },
  { id: 'openai/gpt-oss-120b',                           name: 'GPT OSS 120B',             provider: 'groq', contextWindow: 131072, inputCostPer1M: 0, outputCostPer1M: 0, free: true },
  { id: 'openai/gpt-oss-20b',                            name: 'GPT OSS 20B',              provider: 'groq', contextWindow: 131072, inputCostPer1M: 0, outputCostPer1M: 0, free: true },
  // Groq — Reasoning
  { id: 'qwen/qwen3-32b',                                name: 'Qwen3 32B',                provider: 'groq', contextWindow: 131072, inputCostPer1M: 0, outputCostPer1M: 0, free: true },
  // Groq — Vision
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct',     name: 'Llama 4 Scout (Vision)',   provider: 'groq', contextWindow: 131072, inputCostPer1M: 0, outputCostPer1M: 0, free: true },
  { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick (Vision)', provider: 'groq', contextWindow: 131072, inputCostPer1M: 0, outputCostPer1M: 0, free: true },
  // Groq — Compound (agentic)
  { id: 'compound-beta',                                 name: 'Compound Beta',            provider: 'groq', contextWindow: 131072, inputCostPer1M: 0, outputCostPer1M: 0, free: true },
  { id: 'compound-beta-mini',                            name: 'Compound Beta Mini',       provider: 'groq', contextWindow: 131072, inputCostPer1M: 0, outputCostPer1M: 0, free: true },
];

export function getModel(id: string): ModelInfo | undefined {
  return MODELS.find(m => m.id === id);
}

export function getModelsByProvider(provider: ProviderType): ModelInfo[] {
  return MODELS.filter(m => m.provider === provider);
}
