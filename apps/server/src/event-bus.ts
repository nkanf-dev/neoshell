import type { AgentEvent } from "@neoshell/shared";

type Listener = (event: AgentEvent) => void;

export class ConversationEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(conversationId: string, listener: Listener): () => void {
    const set = this.listeners.get(conversationId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(conversationId, set);
    return () => {
      const current = this.listeners.get(conversationId);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.listeners.delete(conversationId);
      }
    };
  }

  publish(conversationId: string, event: AgentEvent): void {
    const listeners = this.listeners.get(conversationId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(event);
    }
  }
}

