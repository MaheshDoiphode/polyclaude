import * as fs from 'fs';
import { execSync } from 'child_process';
import { POLYCLAUDE_DIR, POLYCLAUDE_ENV, LITELLM_CONFIG } from './config';
import { getLoggedInProviders } from './auth';

const VERSION = require('../package.json').version;

interface DepCheck {
    name: string;
    installed: boolean;
    version?: string;
    hint?: string;
}

function checkCommand(cmd: string, versionFlag: string = '--version'): { installed: boolean; version?: string } {
    try {
        const output = execSync(`${cmd} ${versionFlag}`, {
            encoding: 'utf8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        return { installed: true, version: output.split('\n')[0].trim() };
    } catch {
        return { installed: false };
    }
}

async function checkProxyRunning(port: number = 4000): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
        clearTimeout(timeout);
        return res.ok;
    } catch {
        return false;
    }
}

export async function showStatus(): Promise<void> {
    console.log(`\n📊 Polyclaude v${VERSION} — Status\n`);

    // ── Dependencies ──
    console.log('┌─ Dependencies ─────────────────────────────');
    const deps: DepCheck[] = [];

    const python = checkCommand('python', '--version');
    deps.push({ name: 'Python', ...python, hint: 'Install from python.org' });

    const pip = checkCommand('pip', '--version');
    deps.push({ name: 'pip', ...pip, hint: 'Usually bundled with Python' });

    const litellm = checkCommand('litellm', '--version');
    deps.push({ name: 'LiteLLM Proxy', ...litellm, hint: 'Run: polyclaude setup' });

    const claude = checkCommand('claude', '--version');
    deps.push({ name: 'Claude Code', ...claude, hint: 'npm i -g @anthropic-ai/claude-code' });

    deps.forEach(d => {
        const icon = d.installed ? '✅' : '❌';
        const ver = d.version ? ` (${d.version})` : '';
        const hint = !d.installed && d.hint ? `  → ${d.hint}` : '';
        console.log(`│  ${icon} ${d.name}${ver}${hint}`);
    });

    // ── Authentication ──
    console.log('├─ Authentication ───────────────────────────');
    const loggedIn = getLoggedInProviders();
    const providerList = [
        { name: 'GitHub Copilot', key: 'copilot' },
        { name: 'Google Gemini', key: 'gemini' },
        { name: 'Google Antigravity', key: 'antigravity' },
        { name: 'Anthropic', key: 'anthropic' }
    ];

    providerList.forEach(p => {
        const isAuth = loggedIn.includes(p.key);
        console.log(`│  ${isAuth ? '🔓' : '🔒'} ${p.name}: ${isAuth ? 'Authenticated' : 'Not configured'}`);
    });

    // ── Configuration ──
    console.log('├─ Configuration ────────────────────────────');
    console.log(`│  📁 Config dir:     ${POLYCLAUDE_DIR}`);
    console.log(`│  📄 LiteLLM config: ${fs.existsSync(LITELLM_CONFIG) ? '✅ Generated' : '❌ Not generated'}`);
    console.log(`│  📄 Environment:    ${fs.existsSync(POLYCLAUDE_ENV) ? '✅ Present' : '❌ Not found'}`);

    // ── Proxy ──
    console.log('├─ Proxy ────────────────────────────────────');
    const proxyRunning = await checkProxyRunning();
    console.log(`│  ${proxyRunning ? '🟢 LiteLLM Proxy: Running on http://localhost:4000' : '🔴 LiteLLM Proxy: Not running'}`);

    // ── Overall readiness ──
    const allDeps = deps.every(d => d.installed);
    const hasAuth = loggedIn.length > 0;
    const hasConfig = fs.existsSync(LITELLM_CONFIG);

    console.log('└────────────────────────────────────────────');
    if (allDeps && hasAuth && hasConfig) {
        console.log('\n🎉 Polyclaude is fully configured and ready!');
    } else {
        console.log('\n⚠️  Setup incomplete:');
        if (!allDeps) console.log('   • Install missing dependencies listed above');
        if (!hasAuth) console.log('   • Run: polyclaude login <provider>');
        if (!hasConfig) console.log('   • Run: polyclaude setup');
    }
    console.log('');
}
