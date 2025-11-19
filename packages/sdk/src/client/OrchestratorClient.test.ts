/**
 * Unit tests for OrchestratorClient
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OrchestratorClient } from './OrchestratorClient';
import type { PlanRequest, PlanResponse, ChatRequest, ChatResponse } from '../types';

// Mock fetch
global.fetch = vi.fn();

describe('OrchestratorClient', () => {
  let client: OrchestratorClient;
  const mockEndpoint = 'http://localhost:4000';
  const mockApiKey = 'test-api-key';

  beforeEach(() => {
    client = new OrchestratorClient({
      endpoint: mockEndpoint,
      apiKey: mockApiKey,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with provided config', () => {
      expect(client).toBeDefined();
      expect(client['config'].endpoint).toBe(mockEndpoint);
      expect(client['config'].apiKey).toBe(mockApiKey);
    });

    it('should use default timeout if not provided', () => {
      expect(client['config'].timeout).toBe(30000);
    });

    it('should accept custom timeout', () => {
      const customClient = new OrchestratorClient({
        endpoint: mockEndpoint,
        apiKey: mockApiKey,
        timeout: 60000,
      });
      expect(customClient['config'].timeout).toBe(60000);
    });
  });

  describe('createPlan', () => {
    const mockPlanRequest: PlanRequest = {
      prompt: 'Test prompt',
      capabilities: ['READ_FILES'],
    };

    const mockPlanResponse: PlanResponse = {
      id: 'plan-123',
      status: 'pending',
      prompt: 'Test prompt',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    it('should successfully create a plan', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockPlanResponse,
        headers: new Headers(),
      });

      const result = await client.createPlan(mockPlanRequest);

      expect(result).toEqual(mockPlanResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        `${mockEndpoint}/plan`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${mockApiKey}`,
          }),
          body: JSON.stringify(mockPlanRequest),
        })
      );
    });

    it('should handle API errors', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ error: 'Invalid request' }),
        headers: new Headers(),
      });

      await expect(client.createPlan(mockPlanRequest)).rejects.toThrow(
        'API request failed: 400 Bad Request'
      );
    });

    it('should handle network errors', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      await expect(client.createPlan(mockPlanRequest)).rejects.toThrow(
        'Network error'
      );
    });

    it('should include optional fields in request', async () => {
      const requestWithOptions: PlanRequest = {
        ...mockPlanRequest,
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 1000,
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockPlanResponse,
        headers: new Headers(),
      });

      await client.createPlan(requestWithOptions);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify(requestWithOptions),
        })
      );
    });
  });

  describe('streamPlanEvents', () => {
    it('should stream plan events', async () => {
      const mockEvents = [
        'data: {"type":"step.started","step":{"id":"step-1","name":"Test"}}\n\n',
        'data: {"type":"step.completed","step":{"id":"step-1","status":"completed"}}\n\n',
        'data: [DONE]\n\n',
      ];

      const mockResponse = {
        ok: true,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(mockEvents[0]),
              })
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(mockEvents[1]),
              })
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(mockEvents[2]),
              })
              .mockResolvedValueOnce({ done: true }),
          }),
        },
      };

      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      const events = [];
      for await (const event of client.streamPlanEvents('plan-123')) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('step.started');
      expect(events[1].type).toBe('step.completed');
    });

    it('should handle SSE errors', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
      });

      const generator = client.streamPlanEvents('invalid-plan');
      await expect(generator.next()).rejects.toThrow(
        'API request failed: 404 Not Found'
      );
    });
  });

  describe('chat', () => {
    const mockChatRequest: ChatRequest = {
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    };

    const mockChatResponse: ChatResponse = {
      message: {
        role: 'assistant',
        content: 'Hello! How can I help you?',
      },
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
    };

    it('should successfully send chat request', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockChatResponse,
        headers: new Headers(),
      });

      const result = await client.chat(mockChatRequest);

      expect(result).toEqual(mockChatResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        `${mockEndpoint}/chat`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${mockApiKey}`,
          }),
          body: JSON.stringify(mockChatRequest),
        })
      );
    });

    it('should handle streaming chat responses', async () => {
      const mockStreamResponse = [
        'data: {"delta":"Hello"}\n\n',
        'data: {"delta":" there!"}\n\n',
        'data: [DONE]\n\n',
      ];

      const mockResponse = {
        ok: true,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(mockStreamResponse[0]),
              })
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(mockStreamResponse[1]),
              })
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(mockStreamResponse[2]),
              })
              .mockResolvedValueOnce({ done: true }),
          }),
        },
      };

      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      const chunks = [];
      for await (const chunk of client.streamChat({
        ...mockChatRequest,
        stream: true,
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].delta).toBe('Hello');
      expect(chunks[1].delta).toBe(' there!');
    });
  });

  describe('retry logic', () => {
    it('should retry on transient errors', async () => {
      const mockRequest: PlanRequest = {
        prompt: 'Test',
        capabilities: [],
      };

      const mockResponse: PlanResponse = {
        id: 'plan-123',
        status: 'pending',
        prompt: 'Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (global.fetch as any)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockResponse,
          headers: new Headers(),
        });

      const result = await client.createPlan(mockRequest);

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('should not retry on non-retryable errors', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: 'Invalid API key' }),
        headers: new Headers(),
      });

      await expect(client.createPlan({
        prompt: 'Test',
        capabilities: [],
      })).rejects.toThrow('API request failed: 401 Unauthorized');

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should respect max retries', async () => {
      (global.fetch as any)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'));

      await expect(client.createPlan({
        prompt: 'Test',
        capabilities: [],
      })).rejects.toThrow('Network error');

      expect(global.fetch).toHaveBeenCalledTimes(4); // Initial + 3 retries
    });
  });

  describe('error handling', () => {
    it('should handle malformed JSON responses', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
        headers: new Headers(),
      });

      await expect(client.createPlan({
        prompt: 'Test',
        capabilities: [],
      })).rejects.toThrow('Invalid JSON');
    });

    it('should handle timeout errors', async () => {
      const slowClient = new OrchestratorClient({
        endpoint: mockEndpoint,
        apiKey: mockApiKey,
        timeout: 100,
      });

      (global.fetch as any).mockImplementation(() =>
        new Promise(resolve => setTimeout(resolve, 200))
      );

      await expect(slowClient.createPlan({
        prompt: 'Test',
        capabilities: [],
      })).rejects.toThrow();
    });
  });
});
