/**
 * Unit tests for ToolRegistry
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry, defineTool } from './ToolRegistry';
import type { Tool, ToolCapability } from '../types';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('registerTool', () => {
    it('should register a tool', () => {
      const tool: Tool = {
        name: 'TestTool',
        description: 'A test tool',
        capabilities: ['READ_FILES'],
        parameters: {
          path: {
            type: 'string',
            description: 'File path',
            required: true,
          },
        },
        execute: async (params) => ({ success: true, data: params }),
      };

      registry.registerTool(tool);
      const retrieved = registry.getTool('TestTool');

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('TestTool');
      expect(retrieved?.capabilities).toEqual(['READ_FILES']);
    });

    it('should throw error for duplicate tool names', () => {
      const tool: Tool = {
        name: 'DuplicateTool',
        description: 'First tool',
        capabilities: [],
        execute: async () => ({ success: true }),
      };

      registry.registerTool(tool);

      expect(() => registry.registerTool(tool)).toThrow(
        'Tool with name DuplicateTool already registered'
      );
    });

    it('should validate tool structure', () => {
      const invalidTool = {
        name: '',
        description: 'Invalid tool',
        capabilities: [],
        execute: async () => ({ success: true }),
      } as Tool;

      expect(() => registry.registerTool(invalidTool)).toThrow(
        'Tool name is required'
      );
    });
  });

  describe('getTool', () => {
    it('should return registered tool', () => {
      const tool: Tool = {
        name: 'GetTool',
        description: 'Test',
        capabilities: [],
        execute: async () => ({ success: true }),
      };

      registry.registerTool(tool);
      const retrieved = registry.getTool('GetTool');

      expect(retrieved).toBe(tool);
    });

    it('should return undefined for non-existent tool', () => {
      const retrieved = registry.getTool('NonExistent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getAllTools', () => {
    it('should return all registered tools', () => {
      const tool1: Tool = {
        name: 'Tool1',
        description: 'First',
        capabilities: ['READ_FILES'],
        execute: async () => ({ success: true }),
      };

      const tool2: Tool = {
        name: 'Tool2',
        description: 'Second',
        capabilities: ['WRITE_FILES'],
        execute: async () => ({ success: true }),
      };

      registry.registerTool(tool1);
      registry.registerTool(tool2);

      const allTools = registry.getAllTools();

      expect(allTools).toHaveLength(2);
      expect(allTools.map(t => t.name)).toContain('Tool1');
      expect(allTools.map(t => t.name)).toContain('Tool2');
    });

    it('should return empty array when no tools registered', () => {
      const allTools = registry.getAllTools();
      expect(allTools).toEqual([]);
    });
  });

  describe('getToolsByCapability', () => {
    it('should filter tools by capability', () => {
      const readTool: Tool = {
        name: 'ReadTool',
        description: 'Reads files',
        capabilities: ['READ_FILES'],
        execute: async () => ({ success: true }),
      };

      const writeTool: Tool = {
        name: 'WriteTool',
        description: 'Writes files',
        capabilities: ['WRITE_FILES'],
        execute: async () => ({ success: true }),
      };

      const bothTool: Tool = {
        name: 'BothTool',
        description: 'Read and write',
        capabilities: ['READ_FILES', 'WRITE_FILES'],
        execute: async () => ({ success: true }),
      };

      registry.registerTool(readTool);
      registry.registerTool(writeTool);
      registry.registerTool(bothTool);

      const readTools = registry.getToolsByCapability('READ_FILES');

      expect(readTools).toHaveLength(2);
      expect(readTools.map(t => t.name)).toContain('ReadTool');
      expect(readTools.map(t => t.name)).toContain('BothTool');
    });

    it('should return empty array for non-existent capability', () => {
      const tools = registry.getToolsByCapability('NON_EXISTENT' as ToolCapability);
      expect(tools).toEqual([]);
    });
  });

  describe('executeTool', () => {
    it('should execute registered tool', async () => {
      const tool: Tool = {
        name: 'ExecuteTool',
        description: 'Test execution',
        capabilities: [],
        parameters: {
          input: {
            type: 'string',
            required: true,
          },
        },
        execute: async (params) => ({
          success: true,
          data: `Processed: ${params.input}`,
        }),
      };

      registry.registerTool(tool);

      const result = await registry.executeTool('ExecuteTool', {
        input: 'test data',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBe('Processed: test data');
    });

    it('should validate parameters before execution', async () => {
      const tool: Tool = {
        name: 'ValidatedTool',
        description: 'Test validation',
        capabilities: [],
        parameters: {
          required: {
            type: 'string',
            required: true,
          },
          optional: {
            type: 'number',
            required: false,
          },
        },
        execute: async (params) => ({ success: true, data: params }),
      };

      registry.registerTool(tool);

      // Missing required parameter
      await expect(registry.executeTool('ValidatedTool', {})).rejects.toThrow(
        'Missing required parameter: required'
      );

      // Valid parameters
      const result = await registry.executeTool('ValidatedTool', {
        required: 'value',
        optional: 42,
      });

      expect(result.success).toBe(true);
    });

    it('should throw error for non-existent tool', async () => {
      await expect(registry.executeTool('NonExistent', {})).rejects.toThrow(
        'Tool NonExistent not found'
      );
    });

    it('should handle tool execution errors', async () => {
      const tool: Tool = {
        name: 'ErrorTool',
        description: 'Test error',
        capabilities: [],
        execute: async () => {
          throw new Error('Tool execution failed');
        },
      };

      registry.registerTool(tool);

      await expect(registry.executeTool('ErrorTool', {})).rejects.toThrow(
        'Tool execution failed'
      );
    });
  });

  describe('removeTool', () => {
    it('should remove registered tool', () => {
      const tool: Tool = {
        name: 'RemoveTool',
        description: 'Test removal',
        capabilities: [],
        execute: async () => ({ success: true }),
      };

      registry.registerTool(tool);
      expect(registry.getTool('RemoveTool')).toBeDefined();

      registry.removeTool('RemoveTool');
      expect(registry.getTool('RemoveTool')).toBeUndefined();
    });

    it('should not throw for non-existent tool', () => {
      expect(() => registry.removeTool('NonExistent')).not.toThrow();
    });
  });

  describe('clearTools', () => {
    it('should remove all tools', () => {
      const tool1: Tool = {
        name: 'Tool1',
        description: 'First',
        capabilities: [],
        execute: async () => ({ success: true }),
      };

      const tool2: Tool = {
        name: 'Tool2',
        description: 'Second',
        capabilities: [],
        execute: async () => ({ success: true }),
      };

      registry.registerTool(tool1);
      registry.registerTool(tool2);

      expect(registry.getAllTools()).toHaveLength(2);

      registry.clearTools();

      expect(registry.getAllTools()).toHaveLength(0);
    });
  });
});

describe('defineTool', () => {
  it('should create a tool definition', () => {
    const tool = defineTool({
      name: 'DefinedTool',
      description: 'Test tool definition',
      capabilities: ['READ_FILES', 'WRITE_FILES'],
      parameters: {
        path: {
          type: 'string',
          description: 'File path',
          required: true,
        },
        content: {
          type: 'string',
          description: 'File content',
          required: false,
        },
      },
      execute: async (params) => ({
        success: true,
        data: params,
      }),
    });

    expect(tool.name).toBe('DefinedTool');
    expect(tool.capabilities).toEqual(['READ_FILES', 'WRITE_FILES']);
    expect(tool.parameters).toHaveProperty('path');
    expect(tool.parameters).toHaveProperty('content');
  });

  it('should validate tool definition', () => {
    expect(() => defineTool({
      name: '',
      description: 'Invalid',
      capabilities: [],
      execute: async () => ({ success: true }),
    })).toThrow('Tool name is required');

    expect(() => defineTool({
      name: 'NoDescription',
      description: '',
      capabilities: [],
      execute: async () => ({ success: true }),
    })).toThrow('Tool description is required');
  });

  it('should handle async execute functions', async () => {
    const tool = defineTool({
      name: 'AsyncTool',
      description: 'Async execution',
      capabilities: [],
      execute: async (params) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          success: true,
          data: 'Async result',
        };
      },
    });

    const result = await tool.execute({});
    expect(result.success).toBe(true);
    expect(result.data).toBe('Async result');
  });

  it('should preserve parameter metadata', () => {
    const tool = defineTool({
      name: 'MetadataTool',
      description: 'Test metadata',
      capabilities: [],
      parameters: {
        stringParam: {
          type: 'string',
          description: 'A string parameter',
          required: true,
          default: 'default value',
        },
        numberParam: {
          type: 'number',
          description: 'A number parameter',
          required: false,
          min: 0,
          max: 100,
        },
        booleanParam: {
          type: 'boolean',
          description: 'A boolean parameter',
          required: false,
          default: true,
        },
        arrayParam: {
          type: 'array',
          description: 'An array parameter',
          required: false,
          items: { type: 'string' },
        },
      },
      execute: async () => ({ success: true }),
    });

    expect(tool.parameters?.stringParam).toMatchObject({
      type: 'string',
      required: true,
      default: 'default value',
    });

    expect(tool.parameters?.numberParam).toMatchObject({
      type: 'number',
      required: false,
      min: 0,
      max: 100,
    });

    expect(tool.parameters?.booleanParam).toMatchObject({
      type: 'boolean',
      required: false,
      default: true,
    });

    expect(tool.parameters?.arrayParam).toMatchObject({
      type: 'array',
      required: false,
      items: { type: 'string' },
    });
  });
});
