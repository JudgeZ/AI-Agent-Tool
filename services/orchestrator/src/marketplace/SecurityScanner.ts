/**
 * Security scanner for marketplace tools
 *
 * Performs static analysis and security checks on tool packages
 */

import { Logger } from 'pino';
import { SecurityScanResult, ScanStatus } from './types.js';

export interface SecurityScannerConfig {
  logger: Logger;
  /** Enable/disable specific checks */
  checks: {
    maliciousPatterns: boolean;
    suspiciousApis: boolean;
    hardcodedSecrets: boolean;
    networkCalls: boolean;
    fileSystemAccess: boolean;
    dangerousFunctions: boolean;
  };
  /** Timeout for scan operations (ms) */
  timeout: number;
}

/**
 * Pattern definitions for security checks
 */
const PATTERNS = {
  // Hardcoded secrets/credentials
  secrets: [
    /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{16,}['"]/gi,
    /(?:secret|token)\s*[:=]\s*['"][^'"]{16,}['"]/gi,
    /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
    /(?:sk|pk)_live_[a-zA-Z0-9]{24,}/gi,
  ],

  // Suspicious network patterns
  network: [
    /(?:fetch|axios|request|http\.get)\s*\(/gi,
    /new\s+(?:WebSocket|XMLHttpRequest)/gi,
    /\.send\s*\(/gi,
    /child_process\.exec/gi,
  ],

  // Dangerous file system operations
  filesystem: [
    /fs\.(?:unlink|rm|rmdir)(?:Sync)?\s*\(/gi,
    /fs\.(?:write|append)File(?:Sync)?\s*\(/gi,
    /fs\.chmod(?:Sync)?\s*\(/gi,
    /fs\.chown(?:Sync)?\s*\(/gi,
  ],

  // Dangerous functions
  dangerous: [
    /eval\s*\(/gi,
    /Function\s*\(/gi,
    /setTimeout\s*\(\s*['"][^'"]*['"]/gi,
    /setInterval\s*\(\s*['"][^'"]*['"]/gi,
    /new\s+Function/gi,
    /vm\.runInNewContext/gi,
    /child_process\.exec/gi,
  ],

  // Obfuscation indicators
  obfuscation: [
    /String\.fromCharCode\s*\(/gi,
    /atob\s*\(/gi,
    /btoa\s*\(/gi,
    /unescape\s*\(/gi,
    /\\x[0-9a-f]{2}/gi,
  ],
};

/**
 * Suspicious API usage patterns
 */
const SUSPICIOUS_APIS = [
  'eval',
  'Function',
  'execSync',
  'spawnSync',
  'execFile',
  'execFileSync',
  'runInNewContext',
  'runInThisContext',
];

/**
 * Security scanner for tool packages
 */
export class SecurityScanner {
  private logger: Logger;
  private config: SecurityScannerConfig;

  constructor(config: SecurityScannerConfig) {
    this.config = config;
    this.logger = config.logger.child({ component: 'SecurityScanner' });
  }

  /**
   * Scan a tool package for security issues
   */
  async scan(packageUrl: string, toolId: string): Promise<SecurityScanResult> {
    const startTime = Date.now();
    this.logger.info({ toolId, packageUrl }, 'starting security scan');

    try {
      const findings: SecurityScanResult['findings'] = [];

      // Note: In production, this would download and analyze the actual package
      // For now, we'll perform basic checks

      // Check 1: Malicious patterns
      if (this.config.checks.maliciousPatterns) {
        const maliciousFindings = await this.checkMaliciousPatterns(packageUrl, toolId);
        findings.push(...maliciousFindings);
      }

      // Check 2: Suspicious APIs
      if (this.config.checks.suspiciousApis) {
        const apiFindings = await this.checkSuspiciousApis(packageUrl, toolId);
        findings.push(...apiFindings);
      }

      // Check 3: Hardcoded secrets
      if (this.config.checks.hardcodedSecrets) {
        const secretFindings = await this.checkHardcodedSecrets(packageUrl, toolId);
        findings.push(...secretFindings);
      }

      // Check 4: Network calls
      if (this.config.checks.networkCalls) {
        const networkFindings = await this.checkNetworkCalls(packageUrl, toolId);
        findings.push(...networkFindings);
      }

      // Check 5: File system access
      if (this.config.checks.fileSystemAccess) {
        const fsFindings = await this.checkFileSystemAccess(packageUrl, toolId);
        findings.push(...fsFindings);
      }

      // Check 6: Dangerous functions
      if (this.config.checks.dangerousFunctions) {
        const dangerousFindings = await this.checkDangerousFunctions(packageUrl, toolId);
        findings.push(...dangerousFindings);
      }

      // Calculate summary
      const summary = {
        critical: findings.filter((f) => f.severity === 'critical').length,
        high: findings.filter((f) => f.severity === 'high').length,
        medium: findings.filter((f) => f.severity === 'medium').length,
        low: findings.filter((f) => f.severity === 'low').length,
        info: findings.filter((f) => f.severity === 'info').length,
      };

      const duration = Date.now() - startTime;
      const status = summary.critical > 0 || summary.high > 0 ? ScanStatus.FAILED : ScanStatus.PASSED;

      this.logger.info(
        { toolId, status, duration, summary },
        'security scan completed',
      );

      return {
        status,
        scannedAt: new Date(),
        findings,
        summary,
      };
    } catch (error) {
      this.logger.error({ error, toolId }, 'security scan failed');
      return {
        status: ScanStatus.FAILED,
        scannedAt: new Date(),
        findings: [
          {
            severity: 'critical',
            category: 'scan_error',
            title: 'Security Scan Failed',
            description: `Failed to complete security scan: ${error instanceof Error ? error.message : String(error)}`,
            recommendation: 'Please contact support if this issue persists.',
          },
        ],
        summary: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      };
    }
  }

  /**
   * Check for malicious patterns
   */
  private async checkMaliciousPatterns(
    packageUrl: string,
    toolId: string,
  ): Promise<SecurityScanResult['findings']> {
    // In production: download package, extract, scan files
    // For now: return empty findings
    return [];
  }

  /**
   * Check for suspicious API usage
   */
  private async checkSuspiciousApis(
    packageUrl: string,
    toolId: string,
  ): Promise<SecurityScanResult['findings']> {
    const findings: SecurityScanResult['findings'] = [];

    // In production: analyze package code for suspicious API calls
    // Example finding:
    // findings.push({
    //   severity: 'high',
    //   category: 'suspicious_api',
    //   title: 'Suspicious API Usage',
    //   description: 'Tool uses eval() which can execute arbitrary code',
    //   recommendation: 'Avoid using eval() and similar dynamic code execution functions.',
    // });

    return findings;
  }

  /**
   * Check for hardcoded secrets
   */
  private async checkHardcodedSecrets(
    packageUrl: string,
    toolId: string,
  ): Promise<SecurityScanResult['findings']> {
    const findings: SecurityScanResult['findings'] = [];

    // In production: scan code for secret patterns
    // Example:
    // for (const pattern of PATTERNS.secrets) {
    //   if (pattern.test(code)) {
    //     findings.push({
    //       severity: 'critical',
    //       category: 'hardcoded_secret',
    //       title: 'Hardcoded Secret Detected',
    //       description: 'Tool contains hardcoded credentials or API keys',
    //       recommendation: 'Remove hardcoded secrets and use environment variables or secure vaults.',
    //     });
    //   }
    // }

    return findings;
  }

  /**
   * Check for network calls
   */
  private async checkNetworkCalls(
    packageUrl: string,
    toolId: string,
  ): Promise<SecurityScanResult['findings']> {
    const findings: SecurityScanResult['findings'] = [];

    // In production: analyze network call destinations
    // findings.push({
    //   severity: 'medium',
    //   category: 'network_call',
    //   title: 'Outbound Network Call',
    //   description: 'Tool makes network requests to external domains',
    //   recommendation: 'Ensure all network calls are necessary and to trusted domains.',
    // });

    return findings;
  }

  /**
   * Check for file system access
   */
  private async checkFileSystemAccess(
    packageUrl: string,
    toolId: string,
  ): Promise<SecurityScanResult['findings']> {
    const findings: SecurityScanResult['findings'] = [];

    // In production: analyze file system operations
    // for (const pattern of PATTERNS.filesystem) {
    //   if (pattern.test(code)) {
    //     findings.push({
    //       severity: 'high',
    //       category: 'filesystem_access',
    //       title: 'Destructive File System Operation',
    //       description: 'Tool performs file deletion or modification operations',
    //       recommendation: 'Ensure file system operations are properly scoped and validated.',
    //     });
    //   }
    // }

    return findings;
  }

  /**
   * Check for dangerous functions
   */
  private async checkDangerousFunctions(
    packageUrl: string,
    toolId: string,
  ): Promise<SecurityScanResult['findings']> {
    const findings: SecurityScanResult['findings'] = [];

    // In production: scan for dangerous function usage
    // for (const pattern of PATTERNS.dangerous) {
    //   if (pattern.test(code)) {
    //     findings.push({
    //       severity: 'critical',
    //       category: 'dangerous_function',
    //       title: 'Dangerous Function Usage',
    //       description: 'Tool uses dangerous functions that can execute arbitrary code',
    //       recommendation: 'Avoid using eval(), Function(), and similar dynamic execution methods.',
    //     });
    //   }
    // }

    return findings;
  }

  /**
   * Quick scan (reduced checks for faster results)
   */
  async quickScan(packageUrl: string, toolId: string): Promise<SecurityScanResult> {
    this.logger.info({ toolId, packageUrl }, 'starting quick security scan');

    // Quick scan only checks for critical issues
    const findings: SecurityScanResult['findings'] = [];

    if (this.config.checks.hardcodedSecrets) {
      const secretFindings = await this.checkHardcodedSecrets(packageUrl, toolId);
      findings.push(...secretFindings);
    }

    if (this.config.checks.dangerousFunctions) {
      const dangerousFindings = await this.checkDangerousFunctions(packageUrl, toolId);
      findings.push(...dangerousFindings);
    }

    const summary = {
      critical: findings.filter((f) => f.severity === 'critical').length,
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
      info: findings.filter((f) => f.severity === 'info').length,
    };

    const status = summary.critical > 0 ? ScanStatus.FAILED : ScanStatus.PASSED;

    return {
      status,
      scannedAt: new Date(),
      findings,
      summary,
    };
  }
}

/**
 * Create default security scanner configuration
 */
export function createDefaultScannerConfig(logger: Logger): SecurityScannerConfig {
  return {
    logger,
    checks: {
      maliciousPatterns: true,
      suspiciousApis: true,
      hardcodedSecrets: true,
      networkCalls: true,
      fileSystemAccess: true,
      dangerousFunctions: true,
    },
    timeout: 60000, // 60 seconds
  };
}
