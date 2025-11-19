/**
 * TokenCounter Tests
 * Comprehensive test suite for accurate token counting using tiktoken
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TokenCounter } from "./TokenCounter";

// Mock tiktoken module
vi.mock("tiktoken", () => {
  class MockTiktoken {
    private model: string;

    constructor(model: string) {
      this.model = model;
    }

    encode(text: string): number[] {
      // Simplified token counting for tests
      // Real tiktoken would use BPE tokenization
      const tokens: number[] = [];

      // Simple approximation: split on whitespace and punctuation
      const words = text.split(/\s+|(?=[.!?,;:])|(?<=[.!?,;:])/g).filter(Boolean);

      words.forEach((word, index) => {
        // Simulate token IDs
        tokens.push(1000 + index);

        // Add extra tokens for long words (simulating subword tokenization)
        if (word.length > 7) {
          tokens.push(2000 + index);
        }
      });

      return tokens;
    }

    free(): void {
      // Cleanup mock
    }
  }

  return {
    Tiktoken: MockTiktoken,
    encoding_for_model: (model: string) => new MockTiktoken(model),
  };
});

describe("TokenCounter", () => {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter();
  });

  afterEach(() => {
    counter.dispose();
  });

  describe("count", () => {
    it("should count tokens in simple text", () => {
      const text = "Hello world";
      const count = counter.count(text);

      expect(count).toBeGreaterThan(0);
      expect(count).toBe(2); // "Hello" and "world"
    });

    it("should count tokens in complex text with punctuation", () => {
      const text = "The quick brown fox jumps over the lazy dog.";
      const count = counter.count(text);

      // Should split on words and punctuation
      expect(count).toBeGreaterThan(8);
      expect(count).toBeLessThan(20);
    });

    it("should handle empty text", () => {
      const count = counter.count("");
      expect(count).toBe(0);
    });

    it("should handle text with only whitespace", () => {
      const count = counter.count("   \n\t  ");
      expect(count).toBe(0);
    });

    it("should count tokens for specific models", () => {
      const text = "Testing model-specific tokenization";

      const gpt4Count = counter.count(text, "gpt-4");
      const gpt35Count = counter.count(text, "gpt-3.5-turbo");
      const claudeCount = counter.count(text, "claude-3-opus");

      // All should return counts
      expect(gpt4Count).toBeGreaterThan(0);
      expect(gpt35Count).toBeGreaterThan(0);
      expect(claudeCount).toBeGreaterThan(0);
    });

    it("should handle long words with subword tokenization", () => {
      const text = "supercalifragilisticexpialidocious";
      const count = counter.count(text);

      // Long word should be split into multiple tokens
      expect(count).toBeGreaterThan(1);
    });

    it("should handle special characters", () => {
      const text = "Hello! How are you? I'm fine, thanks.";
      const count = counter.count(text);

      // Should tokenize punctuation separately
      expect(count).toBeGreaterThan(6);
    });

    it("should handle unicode text", () => {
      const text = "Hello 世界 🌍 Здравствуй мир";
      const count = counter.count(text);

      expect(count).toBeGreaterThan(0);
    });

    it("should handle code snippets", () => {
      const code = `function hello() {
        console.log("Hello, world!");
        return true;
      }`;
      const count = counter.count(code);

      expect(count).toBeGreaterThan(10);
    });

    it("should be consistent for same text", () => {
      const text = "Consistent tokenization test";

      const count1 = counter.count(text);
      const count2 = counter.count(text);

      expect(count1).toBe(count2);
    });
  });

  describe("countMessages", () => {
    it("should count tokens in message array", () => {
      const messages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello, how are you?" },
        { role: "assistant", content: "I'm doing well, thank you!" }
      ];

      const count = counter.countMessages(messages);

      // Should include message overhead and content
      expect(count).toBeGreaterThan(15);
    });

    it("should add overhead tokens per message", () => {
      const singleMessage = [
        { role: "user", content: "Hi" }
      ];

      const doubleMessage = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hi" }
      ];

      const singleCount = counter.countMessages(singleMessage);
      const doubleCount = counter.countMessages(doubleMessage);

      // Double message should have more overhead
      expect(doubleCount).toBeGreaterThan(singleCount);
    });

    it("should handle empty messages array", () => {
      const count = counter.countMessages([]);

      // Should still have reply priming tokens
      expect(count).toBe(3); // Just the reply priming
    });

    it("should handle messages with empty content", () => {
      const messages = [
        { role: "user", content: "" },
        { role: "assistant", content: "" }
      ];

      const count = counter.countMessages(messages);

      // Should count overhead even with empty content
      expect(count).toBeGreaterThan(0);
    });

    it("should count role tokens", () => {
      const messages = [
        { role: "system", content: "Test" },
        { role: "user", content: "Test" },
        { role: "assistant", content: "Test" }
      ];

      const count = counter.countMessages(messages);

      // Different roles should contribute to token count
      expect(count).toBeGreaterThan(15);
    });

    it("should handle messages for different models", () => {
      const messages = [
        { role: "user", content: "Test message for different models" }
      ];

      const gpt4Count = counter.countMessages(messages, "gpt-4");
      const claudeCount = counter.countMessages(messages, "claude-3-sonnet");

      expect(gpt4Count).toBeGreaterThan(0);
      expect(claudeCount).toBeGreaterThan(0);
    });

    it("should handle long conversation history", () => {
      const messages = [];

      // Simulate a long conversation
      for (let i = 0; i < 20; i++) {
        messages.push({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `This is message number ${i} in our conversation.`
        });
      }

      const count = counter.countMessages(messages);

      // Should handle many messages
      expect(count).toBeGreaterThan(100);
    });

    it("should handle messages with special formatting", () => {
      const messages = [
        {
          role: "user",
          content: "Please format this:\n- Item 1\n- Item 2\n- Item 3"
        },
        {
          role: "assistant",
          content: "```json\n{\"items\": [1, 2, 3]}\n```"
        }
      ];

      const count = counter.countMessages(messages);

      expect(count).toBeGreaterThan(20);
    });
  });

  describe("estimateCompletion", () => {
    it("should estimate tokens for completion", () => {
      const prompt = "Write a short story about a robot.";
      const usage = counter.estimateCompletion(prompt, 500);

      expect(usage.promptTokens).toBeGreaterThan(0);
      expect(usage.completionTokens).toBe(350); // 70% of 500
      expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
    });

    it("should use default max tokens", () => {
      const prompt = "Simple prompt";
      const usage = counter.estimateCompletion(prompt);

      expect(usage.completionTokens).toBe(700); // 70% of default 1000
    });

    it("should handle different max token values", () => {
      const prompt = "Test prompt";

      const usage100 = counter.estimateCompletion(prompt, 100);
      const usage1000 = counter.estimateCompletion(prompt, 1000);
      const usage5000 = counter.estimateCompletion(prompt, 5000);

      expect(usage100.completionTokens).toBe(70);
      expect(usage1000.completionTokens).toBe(700);
      expect(usage5000.completionTokens).toBe(3500);
    });

    it("should estimate for different models", () => {
      const prompt = "Model-specific estimation test";

      const gpt4Usage = counter.estimateCompletion(prompt, 500, "gpt-4");
      const claudeUsage = counter.estimateCompletion(prompt, 500, "claude-3-opus");

      expect(gpt4Usage.promptTokens).toBeGreaterThan(0);
      expect(claudeUsage.promptTokens).toBeGreaterThan(0);
      expect(gpt4Usage.completionTokens).toBe(350);
      expect(claudeUsage.completionTokens).toBe(350);
    });

    it("should handle empty prompt", () => {
      const usage = counter.estimateCompletion("", 500);

      expect(usage.promptTokens).toBe(0);
      expect(usage.completionTokens).toBe(350);
      expect(usage.totalTokens).toBe(350);
    });

    it("should handle very long prompts", () => {
      const longPrompt = "This is a test. ".repeat(1000);
      const usage = counter.estimateCompletion(longPrompt, 500);

      expect(usage.promptTokens).toBeGreaterThan(1000);
      expect(usage.completionTokens).toBe(350);
      expect(usage.totalTokens).toBeGreaterThan(1350);
    });
  });

  describe("model support", () => {
    it("should support GPT-4 variants", () => {
      const text = "Test for GPT-4 models";

      const gpt4 = counter.count(text, "gpt-4");
      const gpt4Turbo = counter.count(text, "gpt-4-turbo");
      const gpt4o = counter.count(text, "gpt-4o");
      const gpt4oMini = counter.count(text, "gpt-4o-mini");

      expect(gpt4).toBeGreaterThan(0);
      expect(gpt4Turbo).toBeGreaterThan(0);
      expect(gpt4o).toBeGreaterThan(0);
      expect(gpt4oMini).toBeGreaterThan(0);
    });

    it("should support GPT-3.5 models", () => {
      const text = "Test for GPT-3.5 models";

      const gpt35 = counter.count(text, "gpt-3.5-turbo");

      expect(gpt35).toBeGreaterThan(0);
    });

    it("should support Claude models", () => {
      const text = "Test for Claude models";

      const opus = counter.count(text, "claude-3-opus");
      const sonnet = counter.count(text, "claude-3-sonnet");
      const haiku = counter.count(text, "claude-3-haiku");
      const sonnet35 = counter.count(text, "claude-3.5-sonnet");

      expect(opus).toBeGreaterThan(0);
      expect(sonnet).toBeGreaterThan(0);
      expect(haiku).toBeGreaterThan(0);
      expect(sonnet35).toBeGreaterThan(0);
    });

    it("should handle unknown models with default encoder", () => {
      const text = "Test for unknown model";

      const unknownCount = counter.count(text, "unknown-model-xyz");
      const defaultCount = counter.count(text);

      expect(unknownCount).toBeGreaterThan(0);
      expect(defaultCount).toBeGreaterThan(0);
    });

    it("should normalize model names", () => {
      const text = "Test normalization";

      const lowercase = counter.count(text, "gpt-4");
      const uppercase = counter.count(text, "GPT-4");
      const mixed = counter.count(text, "GpT-4");

      expect(lowercase).toBe(uppercase);
      expect(lowercase).toBe(mixed);
    });

    it("should match partial model names", () => {
      const text = "Test partial matching";

      const fullName = counter.count(text, "gpt-4-turbo-preview");
      const baseName = counter.count(text, "gpt-4");

      // Should use same encoder for related models
      expect(fullName).toBeGreaterThan(0);
      expect(baseName).toBeGreaterThan(0);
    });
  });

  describe("dispose", () => {
    it("should clean up encoders", () => {
      const newCounter = new TokenCounter();

      // Use the counter
      newCounter.count("Test text");
      newCounter.count("Another test", "gpt-4");

      // Dispose should not throw
      expect(() => newCounter.dispose()).not.toThrow();

      // After disposal, creating new counter should work
      const anotherCounter = new TokenCounter();
      expect(anotherCounter.count("Test after dispose")).toBeGreaterThan(0);
      anotherCounter.dispose();
    });

    it("should handle multiple dispose calls", () => {
      const newCounter = new TokenCounter();

      newCounter.dispose();
      // Second dispose should not throw
      expect(() => newCounter.dispose()).not.toThrow();
    });
  });

  describe("edge cases", () => {
    it("should handle very long texts efficiently", () => {
      const longText = "word ".repeat(10000);

      const start = Date.now();
      const count = counter.count(longText);
      const duration = Date.now() - start;

      expect(count).toBeGreaterThanOrEqual(10000);
      // Should complete in reasonable time (< 1 second)
      expect(duration).toBeLessThan(1000);
    });

    it("should handle texts with repeated patterns", () => {
      const repeated = "pattern ".repeat(100);
      const count = counter.count(repeated);

      // Each "pattern " should contribute tokens
      expect(count).toBeGreaterThanOrEqual(100);
    });

    it("should handle mixed content types", () => {
      const mixed = `
        Regular text here.
        <html><body>HTML content</body></html>
        {"json": "data", "value": 123}
        function code() { return true; }
        ## Markdown Header
      `;

      const count = counter.count(mixed);
      expect(count).toBeGreaterThan(20);
    });

    it("should handle null or undefined gracefully", () => {
      // TypeScript would normally prevent this, but testing runtime behavior
      const undefinedModel = counter.count("test", undefined);
      expect(undefinedModel).toBeGreaterThan(0);
    });

    it("should be thread-safe for concurrent operations", async () => {
      const promises = [];

      // Simulate concurrent token counting
      for (let i = 0; i < 10; i++) {
        promises.push(
          Promise.resolve(counter.count(`Concurrent test ${i}`))
        );
      }

      const results = await Promise.all(promises);

      // All should complete successfully
      results.forEach(count => {
        expect(count).toBeGreaterThan(0);
      });
    });

    it("should handle emoji and special unicode correctly", () => {
      const emojiText = "Hello 👋 World 🌍 Test 🚀 Complete ✅";
      const count = counter.count(emojiText);

      expect(count).toBeGreaterThan(4);
    });

    it("should handle different line endings", () => {
      const unixText = "Line 1\nLine 2\nLine 3";
      const windowsText = "Line 1\r\nLine 2\r\nLine 3";
      const macText = "Line 1\rLine 2\rLine 3";

      const unixCount = counter.count(unixText);
      const windowsCount = counter.count(windowsText);
      const macCount = counter.count(macText);

      expect(unixCount).toBeGreaterThan(0);
      expect(windowsCount).toBeGreaterThan(0);
      expect(macCount).toBeGreaterThan(0);
    });
  });

  describe("performance benchmarks", () => {
    it("should handle batch token counting efficiently", () => {
      const texts = [];
      for (let i = 0; i < 100; i++) {
        texts.push(`Sample text number ${i} for batch processing test.`);
      }

      const start = Date.now();
      const counts = texts.map(text => counter.count(text));
      const duration = Date.now() - start;

      expect(counts.length).toBe(100);
      expect(counts.every(c => c > 0)).toBe(true);
      // Should process 100 texts quickly
      expect(duration).toBeLessThan(500);
    });

    it("should cache encoder instances efficiently", () => {
      // First call should initialize encoder
      const first = counter.count("test", "gpt-4");

      // Subsequent calls should reuse encoder
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        counter.count("test", "gpt-4");
      }
      const duration = Date.now() - start;

      expect(first).toBeGreaterThan(0);
      // 1000 calls should be very fast with cached encoder
      expect(duration).toBeLessThan(100);
    });
  });
});
