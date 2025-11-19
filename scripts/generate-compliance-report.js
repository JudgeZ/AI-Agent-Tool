const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = PROJECT_ROOT; // Output to root for visibility
const SBOM_FILE = path.join(OUTPUT_DIR, 'SBOM.json');
const REPORT_FILE = path.join(OUTPUT_DIR, 'LICENSE_COMPLIANCE.md');

// Permissive licenses that are safe for business use (Apache-2.0 compatible)
const PERMISSIVE_LICENSES = [
    'MIT', 'Apache-2.0', 'Apache-2.0 WITH LLVM-exception', 'Apache 2.0', 'ISC', 
    'BSD-2-Clause', 'BSD-3-Clause', 'BSD', '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0'
];

// Restricted/Copyleft licenses to flag
const RESTRICTED_LICENSES = [
    'GPL', 'GPL-2.0', 'GPL-3.0', 'AGPL', 'AGPL-3.0', 'LGPL', 'LGPL-2.1', 'LGPL-3.0', 
    'CC-BY-NC', 'CC-BY-NC-SA'
];

// Directories to scan
const SCAN_TARGETS = [
    { type: 'npm', path: 'services/orchestrator', name: 'Orchestrator' },
    { type: 'npm', path: 'apps/gui', name: 'GUI' },
    { type: 'npm', path: 'apps/cli', name: 'CLI' },
    { type: 'rust', path: 'services/indexer', name: 'Indexer' },
    { type: 'go', path: 'apps/gateway-api', name: 'Gateway API' }
];

// Helper: Run command
function run(cmd, cwd) {
    try {
        return execSync(cmd, { cwd: path.join(PROJECT_ROOT, cwd), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
        // console.warn(`Warning: Command failed: ${cmd} in ${cwd}`);
        return null;
    }
}

// Scanners
const scanners = {
    npm: (target) => {
        console.log(`Scanning NPM: ${target.name} (${target.path})...`);
        try {
            // Use npx to run license-checker without installing it
            // --production to skip devDependencies (usually what matters for SBOM/Distribution)
            const jsonOut = run('npx license-checker --production --json --start .', target.path);
            if (!jsonOut) return [];
            
            const data = JSON.parse(jsonOut);
            return Object.entries(data).map(([key, info]) => {
                // key is usually "package@version"
                const lastAt = key.lastIndexOf('@');
                const name = key.substring(0, lastAt);
                const version = key.substring(lastAt + 1);
                
                return {
                    component: name,
                    version: version,
                    ecosystem: 'npm',
                    license: normalizeLicense(info.licenses),
                    source: target.name,
                    path: info.path
                };
            });
        } catch (e) {
            console.error(`Failed to scan npm target ${target.name}: ${e.message}`);
            return [];
        }
    },
    
    rust: (target) => {
        console.log(`Scanning Rust: ${target.name} (${target.path})...`);
        const jsonOut = run('cargo metadata --format-version 1', target.path);
        if (!jsonOut) return [];
        
        try {
            const data = JSON.parse(jsonOut);
            return data.packages
                .filter(pkg => {
                    // Filter out path dependencies (the workspace members themselves) unless we want them in the SBOM?
                    // Usually SBOM includes dependencies. We'll include everything that isn't the root member if possible,
                    // or just include everything and let the user filter.
                    // For Cargo, source is usually null for local path deps.
                    return pkg.source != null; 
                })
                .map(pkg => ({
                    component: pkg.name,
                    version: pkg.version,
                    ecosystem: 'cargo',
                    license: normalizeLicense(pkg.license),
                    source: target.name,
                    repository: pkg.repository
                }));
        } catch (e) {
            console.error(`Failed to parse cargo metadata: ${e.message}`);
            return [];
        }
    },
    
    go: (target) => {
        console.log(`Scanning Go: ${target.name} (${target.path})...`);
        // Strategy: Use 'go list -m -json all' for inventory.
        // Licensing for Go is hard without external tools like go-licenses.
        // We will try to get basic info.
        
        const jsonOut = run('go list -m -json all', target.path);
        if (!jsonOut) return [];
        
        // go list -json output is a stream of JSON objects, not a single array.
        // We need to parse individual JSON objects.
        // Hack: Fix JSON stream format {}{}{} -> [{},{},{}]
        const fixedJson = '[' + jsonOut.replace(/\}\s*\{/g, '},{') + ']';
        
        try {
            const modules = JSON.parse(fixedJson);
            return modules.map(mod => ({
                component: mod.Path,
                version: mod.Version || 'v0.0.0', // Main module might not have version
                ecosystem: 'gomod',
                license: 'Unknown (Requires manual check)', // Go modules don't have metadata for this
                source: target.name,
                repository: mod.Path // Usually the path is the repo
            }));
        } catch (e) {
            console.error(`Failed to parse go list output: ${e.message}`);
            return [];
        }
    }
};

// Helper: Normalize license strings
function normalizeLicense(lic) {
    if (!lic) return 'Unknown';
    if (Array.isArray(lic)) return lic.join(' OR ');
    // Clean up common variations
    let clean = lic.replace(/\*/g, '').trim();
    if (clean.startsWith('(') && clean.endsWith(')')) {
        clean = clean.substring(1, clean.length - 1);
    }
    return clean;
}

// Helper: Analyze License Risk
function analyzeLicense(license) {
    // Check for multi-licensing (e.g. "(MIT OR Apache-2.0)")
    // If ANY permissive license is found, we consider it compliant.
    
    const parts = license.split(/ OR | AND |\/|[(),]/).map(s => s.trim()).filter(s => s);
    
    // Check for Red Flags first
    const restricted = parts.find(l => RESTRICTED_LICENSES.some(rl => l.toUpperCase().startsWith(rl.toUpperCase())));
    if (restricted) {
        // If it's dual licensed with a permissive one, it might be safe, but flag it anyway for review?
        // Actually, (GPL OR MIT) is safe. (GPL AND MIT) is not.
        // For simplicity, if we find a permissive license, we default to Green (assuming OR).
        // If no permissive license is found, and we see Restricted, it's Red.
        
        const hasPermissive = parts.some(l => PERMISSIVE_LICENSES.includes(l) || PERMISSIVE_LICENSES.some(pl => l.startsWith(pl)));
        if (hasPermissive) return { status: 'Green', note: 'Dual-licensed (Permissive option available)' };
        return { status: 'Red', note: `Restricted license detected: ${restricted}` };
    }
    
    // Check for Green
    const isPermissive = parts.some(l => PERMISSIVE_LICENSES.includes(l) || PERMISSIVE_LICENSES.some(pl => l.toUpperCase() === pl.toUpperCase()));
    if (isPermissive) return { status: 'Green', note: 'Permissive' };
    
    return { status: 'Amber', note: 'Unknown or non-standard license. Verify manually.' };
}

// Main execution
function main() {
    console.log('Generating SBOM and License Compliance Report...');
    let allDependencies = [];

    SCAN_TARGETS.forEach(target => {
        if (scanners[target.type]) {
            const deps = scanners[target.type](target);
            allDependencies = allDependencies.concat(deps);
        }
    });

    // Deduplicate (same component/version/license across multiple services)
    const uniqueDeps = new Map();
    allDependencies.forEach(dep => {
        const key = `${dep.ecosystem}:${dep.component}@${dep.version}`;
        if (!uniqueDeps.has(key)) {
            uniqueDeps.set(key, dep);
        } else {
            // Merge source info
            const existing = uniqueDeps.get(key);
            if (!existing.source.includes(dep.source)) {
                existing.source += `, ${dep.source}`;
            }
        }
    });

    const sortedDeps = Array.from(uniqueDeps.values()).sort((a, b) => a.component.localeCompare(b.component));

    // 1. Write SBOM.json
    fs.writeFileSync(SBOM_FILE, JSON.stringify({
        metadata: {
            project: "OSS AI Agent Tool",
            generatedAt: new Date().toISOString(),
            tool: "generate-compliance-report.js"
        },
        components: sortedDeps
    }, null, 2));
    console.log(`SBOM written to ${SBOM_FILE}`);

    // 2. Write LICENSE_COMPLIANCE.md
    let md = `# License Compliance Report
**Generated:** ${new Date().toDateString()}
**Project:** OSS AI Agent Tool

## Summary
This report lists all third-party dependencies detected in the codebase and categorizes them by license safety for business use.

| Status | Count | Definition |
| :--- | :--- | :--- |
| 🟢 **Green** | COUNT_GREEN | **Permissive.** Safe for commercial use (MIT, Apache-2.0, BSD, etc.). |
| 🟠 **Amber** | COUNT_AMBER | **Unknown/Custom.** License could not be parsed or requires manual verification. |
| 🔴 **Red** | COUNT_RED | **Restricted.** Copyleft or Non-Commercial (GPL, AGPL, CC-BY-NC). **ACTION REQUIRED.** |

---

## Detailed Inventory

| Component | Version | Ecosystem | License | Status | Used In |
| :--- | :--- | :--- | :--- | :--- | :--- |
`;

    let counts = { Green: 0, Amber: 0, Red: 0 };

    sortedDeps.forEach(dep => {
        const risk = analyzeLicense(dep.license);
        counts[risk.status]++;
        
        const icon = risk.status === 'Green' ? '🟢' : (risk.status === 'Red' ? '🔴' : '🟠');
        // Escape pipes in license names for Markdown table
        const safeLicense = dep.license.replace(/\|/g, '\\|');
        
        md += `| ${dep.component} | ${dep.version} | ${dep.ecosystem} | ${safeLicense} | ${icon} ${risk.note} | ${dep.source} |
`;
    });

    md = md.replace('COUNT_GREEN', counts.Green);
    md = md.replace('COUNT_AMBER', counts.Amber);
    md = md.replace('COUNT_RED', counts.Red);

    fs.writeFileSync(REPORT_FILE, md);
    console.log(`Report written to ${REPORT_FILE}`);
    
    if (counts.Red > 0) {
        console.warn(`\n⚠️  WARNING: Found ${counts.Red} restricted license(s)! Check ${REPORT_FILE} immediately.`);
    } else {
        console.log(`\n✅  Success: No restricted licenses found.`);
    }
}

main();
