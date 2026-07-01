import * as vscode from 'vscode';
import { UsageResult, WeeklyStats, ProviderStats } from '../types';

export class UsageTracker {
  private static readonly KEY = 'webdev.weeklyStats';

  constructor(private readonly state: vscode.Memento) {}

  private getWeekStart(): string {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now.setDate(diff));
    return monday.toISOString().split('T')[0];
  }

  async track(usage: UsageResult): Promise<void> {
    const weekStart = this.getWeekStart();
    const stats = this.get();

    if (stats.weekStart !== weekStart) {
      // New week: reset
      await this.state.update(UsageTracker.KEY, {
        weekStart,
        providers: {}
      });
    }

    const current = this.get();
    const provider = current.providers[usage.provider] || {
      inputTokens: 0, outputTokens: 0, estimatedCost: 0, calls: 0
    } as ProviderStats;

    provider.inputTokens += usage.inputTokens;
    provider.outputTokens += usage.outputTokens;
    provider.estimatedCost += usage.estimatedCost;
    provider.calls += 1;

    current.providers[usage.provider] = provider;
    await this.state.update(UsageTracker.KEY, current);
  }

  get(): WeeklyStats {
    return this.state.get<WeeklyStats>(UsageTracker.KEY, {
      weekStart: this.getWeekStart(),
      providers: {}
    });
  }

  getTotals(): { tokens: number; cost: number; calls: number } {
    const stats = this.get();
    let tokens = 0;
    let cost = 0;
    let calls = 0;
    for (const p of Object.values(stats.providers)) {
      tokens += p.inputTokens + p.outputTokens;
      cost += p.estimatedCost;
      calls += p.calls;
    }
    return { tokens, cost, calls };
  }
}
