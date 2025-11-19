/**
 * TokenCounter - Accurate token counting using tiktoken
 * Phase 5 implementation for cost tracking
 */

import { Tiktoken, encoding_for_model } from 'tiktoken';
import { TokenUsage } from './types';

export class TokenCounter {
  private encoders: Map<string, Tiktoken> = new Map();

  constructor() {
    // Pre-load common model encodings
    this.initializeEncoders();
  }

  private initializeEncoders(): void {
    // GPT-4 and GPT-3.5 models use cl100k_base encoding
    const cl100k = encoding_for_model('gpt-4');
    this.encoders.set('gpt-4', cl100k);
    this.encoders.set('gpt-4-turbo', cl100k);
    this.encoders.set('gpt-3.5-turbo', cl100k);
    this.encoders.set('gpt-4o', cl100k);
    this.encoders.set('gpt-4o-mini', cl100k);

    // Claude models approximate with cl100k_base (similar tokenization)
    this.encoders.set('claude-3-opus', cl100k);
    this.encoders.set('claude-3-sonnet', cl100k);
    this.encoders.set('claude-3-haiku', cl100k);
    this.encoders.set('claude-3.5-sonnet', cl100k);

    // Default encoder for unknown models
    this.encoders.set('default', cl100k);
  }

  /**
   * Count tokens in a text string for a specific model
   */
  count(text: string, model?: string): number {
    const encoder = this.getEncoder(model);
    const tokens = encoder.encode(text);
    return tokens.length;
  }

  /**
   * Count tokens in a message array (for chat models)
   */
  countMessages(messages: Array<{ role: string; content: string }>, model?: string): number {
    let total = 0;
    const encoder = this.getEncoder(model);

    // Each message has overhead tokens for formatting
    // Based on OpenAI's token counting guidelines
    const messageOverhead = 4; // tokens per message
    const replyPriming = 3; // tokens for assistant reply priming

    for (const message of messages) {
      total += messageOverhead;

      // Count role tokens
      if (message.role) {
        total += encoder.encode(message.role).length;
      }

      // Count content tokens
      if (message.content) {
        total += encoder.encode(message.content).length;
      }
    }

    // Add reply priming tokens
    total += replyPriming;

    return total;
  }

  /**
   * Estimate tokens for a completion based on prompt and max tokens
   */
  estimateCompletion(prompt: string, maxTokens: number = 1000, model?: string): TokenUsage {
    const promptTokens = this.count(prompt, model);

    // Conservative estimate: assume we'll use 70% of max tokens on average
    const estimatedCompletionTokens = Math.floor(maxTokens * 0.7);

    return {
      promptTokens,
      completionTokens: estimatedCompletionTokens,
      totalTokens: promptTokens + estimatedCompletionTokens
    };
  }

  /**
   * Get the appropriate encoder for a model
   */
  private getEncoder(model?: string): Tiktoken {
    if (!model) {
      return this.encoders.get('default')!;
    }

    // Normalize model name
    const normalizedModel = model.toLowerCase();

    // Try exact match first
    if (this.encoders.has(normalizedModel)) {
      return this.encoders.get(normalizedModel)!;
    }

    // Try to find a matching base model
    for (const [key, encoder] of this.encoders.entries()) {
      if (normalizedModel.includes(key) || key.includes(normalizedModel.split('-')[0])) {
        return encoder;
      }
    }

    // Fallback to default
    return this.encoders.get('default')!;
  }

  /**
   * Clean up encoders to free memory
   */
  dispose(): void {
    for (const encoder of this.encoders.values()) {
      encoder.free();
    }
    this.encoders.clear();
  }
}
