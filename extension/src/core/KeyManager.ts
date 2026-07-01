import * as vscode from 'vscode';
import { ProviderType } from '../types';

export class KeyManager {
  private static readonly PREFIX = 'webdev.apikey.';

  // Uses globalState (plain JSON on disk) instead of SecretStorage so keys
  // survive VSCode restarts in remote/container environments.
  constructor(private readonly state: vscode.Memento) {}

  async save(provider: 'groq', key: string): Promise<void> {
    await this.state.update(KeyManager.PREFIX + provider, key);
  }

  get(provider: 'groq'): string | undefined {
    return this.state.get<string>(KeyManager.PREFIX + provider);
  }

  async delete(provider: 'groq'): Promise<void> {
    await this.state.update(KeyManager.PREFIX + provider, undefined);
  }

  isConfigured(provider: 'groq'): boolean {
    const key = this.get(provider);
    return !!key && key.trim().length > 0;
  }

  getStatus(): Record<ProviderType, boolean> {
    return { groq: this.isConfigured('groq') };
  }
}
