/**
 * Tests for marketplace type utilities
 */

import { describe, it, expect } from 'vitest';
import { compareVersions, formatVersion, parseVersion, type ToolVersion } from './types.js';

describe('Version utilities', () => {
  describe('compareVersions', () => {
    it('should compare major versions correctly', () => {
      const v1: ToolVersion = { major: 2, minor: 0, patch: 0 };
      const v2: ToolVersion = { major: 1, minor: 9, patch: 9 };

      expect(compareVersions(v1, v2)).toBeGreaterThan(0);
      expect(compareVersions(v2, v1)).toBeLessThan(0);
    });

    it('should compare minor versions correctly', () => {
      const v1: ToolVersion = { major: 1, minor: 5, patch: 0 };
      const v2: ToolVersion = { major: 1, minor: 3, patch: 9 };

      expect(compareVersions(v1, v2)).toBeGreaterThan(0);
      expect(compareVersions(v2, v1)).toBeLessThan(0);
    });

    it('should compare patch versions correctly', () => {
      const v1: ToolVersion = { major: 1, minor: 0, patch: 5 };
      const v2: ToolVersion = { major: 1, minor: 0, patch: 3 };

      expect(compareVersions(v1, v2)).toBeGreaterThan(0);
      expect(compareVersions(v2, v1)).toBeLessThan(0);
    });

    it('should handle equal versions', () => {
      const v1: ToolVersion = { major: 1, minor: 2, patch: 3 };
      const v2: ToolVersion = { major: 1, minor: 2, patch: 3 };

      expect(compareVersions(v1, v2)).toBe(0);
    });

    it('should handle prerelease versions', () => {
      const stable: ToolVersion = { major: 1, minor: 0, patch: 0 };
      const prerelease: ToolVersion = { major: 1, minor: 0, patch: 0, prerelease: 'alpha.1' };

      expect(compareVersions(stable, prerelease)).toBeGreaterThan(0);
      expect(compareVersions(prerelease, stable)).toBeLessThan(0);
    });

    it('should compare prerelease strings', () => {
      const alpha: ToolVersion = { major: 1, minor: 0, patch: 0, prerelease: 'alpha.1' };
      const beta: ToolVersion = { major: 1, minor: 0, patch: 0, prerelease: 'beta.1' };

      expect(compareVersions(alpha, beta)).toBeLessThan(0);
      expect(compareVersions(beta, alpha)).toBeGreaterThan(0);
    });
  });

  describe('formatVersion', () => {
    it('should format basic version', () => {
      const version: ToolVersion = { major: 1, minor: 2, patch: 3 };
      expect(formatVersion(version)).toBe('1.2.3');
    });

    it('should format version with prerelease', () => {
      const version: ToolVersion = { major: 1, minor: 0, patch: 0, prerelease: 'alpha.1' };
      expect(formatVersion(version)).toBe('1.0.0-alpha.1');
    });

    it('should format version with build metadata', () => {
      const version: ToolVersion = { major: 1, minor: 0, patch: 0, build: '20230101' };
      expect(formatVersion(version)).toBe('1.0.0+20230101');
    });

    it('should format version with prerelease and build', () => {
      const version: ToolVersion = {
        major: 1,
        minor: 0,
        patch: 0,
        prerelease: 'beta.2',
        build: 'exp.sha.5114f85',
      };
      expect(formatVersion(version)).toBe('1.0.0-beta.2+exp.sha.5114f85');
    });
  });

  describe('parseVersion', () => {
    it('should parse basic version', () => {
      const result = parseVersion('1.2.3');
      expect(result).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    it('should parse version with prerelease', () => {
      const result = parseVersion('1.0.0-alpha.1');
      expect(result).toEqual({
        major: 1,
        minor: 0,
        patch: 0,
        prerelease: 'alpha.1',
      });
    });

    it('should parse version with build metadata', () => {
      const result = parseVersion('1.0.0+20230101');
      expect(result).toEqual({
        major: 1,
        minor: 0,
        patch: 0,
        build: '20230101',
      });
    });

    it('should parse version with prerelease and build', () => {
      const result = parseVersion('2.1.3-rc.1+build.123');
      expect(result).toEqual({
        major: 2,
        minor: 1,
        patch: 3,
        prerelease: 'rc.1',
        build: 'build.123',
      });
    });

    it('should return null for invalid version strings', () => {
      expect(parseVersion('invalid')).toBeNull();
      expect(parseVersion('1.2')).toBeNull();
      expect(parseVersion('v1.2.3')).toBeNull();
      expect(parseVersion('1.2.3.4')).toBeNull();
    });

    it('should handle complex prerelease identifiers', () => {
      const result = parseVersion('1.0.0-alpha.beta.1');
      expect(result).toEqual({
        major: 1,
        minor: 0,
        patch: 0,
        prerelease: 'alpha.beta.1',
      });
    });
  });

  describe('round-trip conversions', () => {
    it('should preserve version through format and parse', () => {
      const original: ToolVersion = { major: 1, minor: 2, patch: 3 };
      const formatted = formatVersion(original);
      const parsed = parseVersion(formatted);

      expect(parsed).toEqual(original);
    });

    it('should preserve complex version through format and parse', () => {
      const original: ToolVersion = {
        major: 2,
        minor: 1,
        patch: 0,
        prerelease: 'beta.11',
        build: 'sha.exp.5114f85',
      };
      const formatted = formatVersion(original);
      const parsed = parseVersion(formatted);

      expect(parsed).toEqual(original);
    });
  });
});
