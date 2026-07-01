import { ChatMessage } from '../types';

const STACK_PROMPTS: Record<string, string> = {
  laravel:    'You are WebDev AI, an expert in Laravel, PHP, MySQL, Blade, Livewire, and REST APIs. Help with bug triage, code review, stack traces, migrations, and architecture. Be concise and always show code examples.',
  react:      'You are WebDev AI, an expert in React, TypeScript, Next.js, Tailwind CSS, and frontend architecture. Help with bugs, component design, performance, and state management. Be concise and always show code examples.',
  fullstack:  'You are WebDev AI, an expert in full-stack web development: Laravel, PHP, React, TypeScript, MySQL, REST APIs, and DevOps. Help with bug triage, code review, architecture, and log analysis. Be concise and always show code examples.',
  node:       'You are WebDev AI, an expert in Node.js, Express, TypeScript, PostgreSQL, and REST/GraphQL APIs. Help with bug triage, code review, performance, and architecture. Be concise and always show code examples.',
  wordpress:  'You are WebDev AI, an expert in WordPress, PHP, WooCommerce, ACF, and theme/plugin development. Help with bugs, hooks, performance, and security. Be concise and always show code examples.',
  custom:     '',
};

export const STACK_OPTIONS = [
  { id: 'laravel',   label: '$(server-process) Laravel / PHP',        description: 'Laravel, PHP, MySQL, Blade, Livewire' },
  { id: 'react',     label: '$(symbol-color) React / TypeScript',      description: 'React, Next.js, TypeScript, Tailwind' },
  { id: 'fullstack', label: '$(globe) Full Stack (Laravel + React)',   description: 'Laravel, React, TypeScript, MySQL' },
  { id: 'node',      label: '$(terminal) Node.js / TypeScript',        description: 'Node, Express, PostgreSQL, REST/GraphQL' },
  { id: 'wordpress', label: '$(extensions) WordPress / WooCommerce',   description: 'PHP, WooCommerce, ACF, hooks' },
  { id: 'custom',    label: '$(edit) Prompt personalizzato',           description: 'Scrivi il tuo system prompt' },
];

export class SessionManager {
  private messages: ChatMessage[] = [];
  private customPrompt?: string;

  constructor(private readonly savedPrompt?: string) {
    this.customPrompt = savedPrompt;
  }

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  getMessagesForApi(): { role: 'user' | 'assistant'; content: string }[] {
    return this.messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }

  getSystemPrompt(): string {
    return this.customPrompt ?? STACK_PROMPTS['fullstack'];
  }

  setSystemPrompt(prompt: string): void {
    this.customPrompt = prompt;
  }

  setStack(stackId: string, customText?: string): void {
    if (stackId === 'custom' && customText) {
      this.customPrompt = customText;
    } else {
      this.customPrompt = STACK_PROMPTS[stackId] ?? STACK_PROMPTS['fullstack'];
    }
  }

  getActiveStack(): string {
    const prompt = this.customPrompt ?? STACK_PROMPTS['fullstack'];
    for (const [id, p] of Object.entries(STACK_PROMPTS)) {
      if (p === prompt && id !== 'custom') return id;
    }
    return 'custom';
  }

  addUser(content: string): void {
    this.messages.push({ role: 'user', content, timestamp: Date.now() });
  }

  addAssistant(content: string): void {
    this.messages.push({ role: 'assistant', content, timestamp: Date.now() });
  }

  clear(): void {
    this.messages = [];
  }

  getCount(): number {
    return this.messages.length;
  }
}
