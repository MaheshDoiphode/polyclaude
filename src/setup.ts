import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import prompts from 'prompts';
import { ensureDirectories, POLYCLAUDE_ENV, setupLitellmEnv, POLYCLAUDE_DIR } from './config';
import { doSync } from './sync';

function commandExists(cmd: string): boolean {
    try {
        execSync(`${cmd} --version`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
        return true;
    } catch {
        return false;
    }
}

function getPythonCmd(): string | null {
    if (commandExists('python')) return 'python';
    if (commandExists('python3')) return 'python3';
    if (commandExists('py')) return 'py';
    return null;
}

function getPipCmd(pythonCmd: string): string | null {
    if (commandExists('pip')) return 'pip';
    if (commandExists('pip3')) return 'pip3';
    // Fallback: python -m pip
    try {
        execSync(`${pythonCmd} -m pip --version`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
        return `${pythonCmd} -m pip`;
    } catch {
        return null;
    }
}

async function installLitellm(pipCmd: string): Promise<boolean> {
    console.log('\n📦 Installing LiteLLM Proxy...');
    console.log('   Running: ' + pipCmd + ' install "litellm[proxy]"\n');

    try {
        const result = spawnSync(pipCmd.split(' ')[0], [...pipCmd.split(' ').slice(1), 'install', 'litellm[proxy]'], {
            stdio: 'inherit',
            shell: true,
            timeout: 300000 // 5 min timeout
        });

        if (result.status === 0) {
            console.log('\n✅ LiteLLM Proxy installed successfully!');
            return true;
        } else {
            console.error('\n❌ LiteLLM installation failed (exit code: ' + result.status + ')');
            console.log('   Try manually: ' + pipCmd + ' install "litellm[proxy]"');
            return false;
        }
    } catch (e: any) {
        console.error('❌ Installation error:', e.message);
        return false;
    }
}

function installClaude(): void {
    console.log('\n⚠️  Claude Code is not installed.');
    console.log('   Install it with: npm install -g @anthropic-ai/claude-code');
    console.log('   Then run: polyclaude setup\n');
}

/**
 * Full auto-setup: checks and installs all dependencies, generates config.
 * Called by `polyclaude setup` and also triggered on first run if deps are missing.
 */
export async function autoSetup(quiet: boolean = false): Promise<boolean> {
    ensureDirectories();

    if (!quiet) console.log('\n🔧 Polyclaude Auto-Setup\n');

    // 1. Check Python
    const pythonCmd = getPythonCmd();
    if (!pythonCmd) {
        console.error('❌ Python is not installed or not in PATH.');
        console.log('   Please install Python from https://python.org');
        console.log('   Make sure to check "Add Python to PATH" during installation.\n');
        return false;
    }
    if (!quiet) console.log(`✅ Python found: ${pythonCmd}`);

    // 2. Check pip
    const pipCmd = getPipCmd(pythonCmd);
    if (!pipCmd) {
        console.error('❌ pip is not available.');
        console.log(`   Try: ${pythonCmd} -m ensurepip --upgrade\n`);
        return false;
    }
    if (!quiet) console.log(`✅ pip found: ${pipCmd}`);

    // 3. Check/Install LiteLLM
    if (!commandExists('litellm')) {
        if (!quiet) {
            const { install } = await prompts({
                type: 'confirm',
                name: 'install',
                message: 'LiteLLM Proxy is not installed. Install it now?',
                initial: true
            });

            if (!install) {
                console.log('   Skipping LiteLLM installation. You can install manually:');
                console.log(`   ${pipCmd} install "litellm[proxy]"\n`);
                return false;
            }
        }

        const success = await installLitellm(pipCmd);
        if (!success) return false;
    } else {
        if (!quiet) console.log('✅ LiteLLM Proxy is installed');
    }

    // 4. Check Claude Code
    if (!commandExists('claude')) {
        installClaude();
        // Don't block setup - user may install it later
    } else {
        if (!quiet) console.log('✅ Claude Code is installed');
    }

    // 5. Generate keys
    if (!quiet) console.log('\n🔑 Setting up authentication keys...');
    const masterKey = setupLitellmEnv();
    if (!quiet) console.log('✅ LiteLLM master key configured');

    // 6. Sync models and config
    if (!quiet) console.log('\n🔄 Syncing models and generating configuration...');
    try {
        await doSync(quiet);
    } catch (e: any) {
        // If sync fails (e.g., no copilot auth), still report partial success
        if (!quiet) console.log(`⚠️  Model sync had issues: ${e.message}`);
        if (!quiet) console.log('   Run: polyclaude login copilot  (to add GitHub Copilot)');
    }

    if (!quiet) {
        console.log('\n🎉 Polyclaude setup complete!');
        console.log('\nNext steps:');
        console.log('  1. polyclaude login copilot       — Authenticate with GitHub Copilot');
        console.log('  2. polyclaude login antigravity    — (Optional) Add Antigravity models');
        console.log('  3. polyclaude --model <model>      — Start coding!\n');
    }

    return true;
}

/**
 * Quick dependency check - returns true if all critical deps are available.
 * Used to decide whether to trigger auto-setup on first run.
 */
export function checkDependencies(): { ok: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!getPythonCmd()) missing.push('python');
    if (!commandExists('litellm')) missing.push('litellm');
    return { ok: missing.length === 0, missing };
}
