#!/usr/bin/env node
import { doSync, REQUIRED_FALLBACK_MAPPINGS } from './sync';
import { startProxy, runClaude } from './proxy';
import { loginFlow, logoutFlow } from './auth';
import { LITELLM_CONFIG } from './config';
import { showStatus } from './status';
import { autoSetup, checkDependencies } from './setup';
import { aliasCommand, resolveAlias, listAliases } from './aliases';
import * as fs from 'fs';
import prompts from 'prompts';
import { execSync, spawnSync } from 'child_process';

const VERSION = require('../package.json').version;

function showHelp() {
    console.log(`
  Polyclaude v${VERSION} — Universal multi-provider proxy for Claude Code

  USAGE
    polyclaude                         Launch with interactive model selection
    polyclaude --model <model>         Launch with a specific model
    polyclaude <command> [options]     Run a command

  COMMANDS
    setup               Install dependencies and configure everything automatically
    login [provider]    Authenticate with a provider (copilot, antigravity, gemini, anthropic)
    logout [provider]   Remove credentials for a provider
    list                List all available models
    status              Show dependency, auth, and configuration status
    run <prompt>        Run a one-shot prompt (non-interactive)
    start               Start the LiteLLM proxy in foreground
    config [action]     Manage configuration (view, set, reset)
    alias [action]      Manage model aliases (set, list, remove)
    upgrade             Update Polyclaude to the latest version
    help                Show this help message
    version             Show version

  FLAGS
    --model <name>      Specify model to use with Claude Code (supports aliases)
    --quiet             Suppress startup messages

  EXAMPLES
    polyclaude setup                          First-time setup (installs everything)
    polyclaude login copilot                  Login to GitHub Copilot
    polyclaude login antigravity              Login to Google Antigravity
    polyclaude --model copilot/gpt-4o         Start with a specific model
    polyclaude alias set fast copilot/gpt-4o  Create a model alias
    polyclaude --model fast                   Use an alias
    polyclaude run "fix the bug" --model fast One-shot prompt
    polyclaude config view                    View current configuration
    polyclaude stats                          Show usage statistics
    polyclaude list                           Show available models
`);
}

function getAvailableModels(): string[] {
    if (!fs.existsSync(LITELLM_CONFIG)) return [];

    const configStr = fs.readFileSync(LITELLM_CONFIG, 'utf8');
    const models: string[] = [];
    configStr.split('\n').forEach(line => {
        const match = line.match(/- model_name:\s*(.*)/);
        if (match) {
            const model = match[1]?.trim();
            if (model && !REQUIRED_FALLBACK_MAPPINGS.includes(model)) {
                models.push(model);
            }
        }
    });
    return models;
}

async function selectModel(): Promise<string | null> {
    const models = getAvailableModels();

    if (models.length === 0) {
        console.log('❌ No models available. Run: polyclaude setup');
        return null;
    }

    const response = await prompts({
        type: 'select',
        name: 'model',
        message: '🌟 Select a model to use with Claude Code:',
        choices: models.map(m => ({ title: m, value: m })),
    });

    return response.model || null;
}

function resolveModelArg(args: string[]): string[] {
    const modelIdx = args.indexOf('--model');
    if (modelIdx !== -1 && args[modelIdx + 1]) {
        args[modelIdx + 1] = resolveAlias(args[modelIdx + 1]);
    }
    return args;
}

async function doUpgrade() {
    console.log('🔄 Checking for updates...\n');

    try {
        // Check current vs latest version
        const latestRaw = execSync('npm view polyclaude version', { encoding: 'utf8', timeout: 15000 }).trim();
        console.log(`  Current version: ${VERSION}`);
        console.log(`  Latest version:  ${latestRaw}`);

        if (latestRaw === VERSION) {
            console.log('\n✅ Already on the latest version!');
            return;
        }

        console.log('\n📦 Updating Polyclaude...\n');
        const result = spawnSync('npm', ['update', '-g', 'polyclaude'], {
            stdio: 'inherit',
            shell: true,
            timeout: 120000
        });

        if (result.status === 0) {
            console.log('\n✅ Polyclaude updated successfully!');
        } else {
            console.error('\n❌ Update failed. Try manually: npm update -g polyclaude');
        }
    } catch (e: any) {
        console.error('❌ Failed to check for updates:', e.message);
        console.log('   Try manually: npm update -g polyclaude');
    }
}

async function doConfigCommand(args: string[]) {
    const action = args[0] || 'view';

    switch (action) {
        case 'view':
        case 'show': {
            const { POLYCLAUDE_ENV, POLYCLAUDE_DIR } = require('./config');
            console.log(`\n⚙️  Polyclaude Configuration\n`);
            console.log(`📁 Config directory: ${POLYCLAUDE_DIR}`);

            if (fs.existsSync(POLYCLAUDE_ENV)) {
                const content = fs.readFileSync(POLYCLAUDE_ENV, 'utf8');
                console.log('\n📄 Environment variables (.env):');
                content.split('\n').filter(l => l.trim()).forEach(line => {
                    const [key, ...rest] = line.split('=');
                    const value = rest.join('=');
                    // Mask sensitive values
                    const masked = key?.includes('KEY') || key?.includes('SECRET') || key?.includes('TOKEN')
                        ? value.substring(0, 8) + '...' + value.substring(value.length - 4)
                        : value;
                    console.log(`  ${key} = ${masked}`);
                });
            } else {
                console.log('\n📄 No .env file found. Run: polyclaude setup');
            }

            // Show aliases
            listAliases();
            break;
        }

        case 'set': {
            const keyValue = args[1];
            if (!keyValue || !keyValue.includes('=')) {
                console.log('Usage: polyclaude config set KEY=VALUE');
                console.log('Example: polyclaude config set GEMINI_API_KEY=your-key-here');
                return;
            }
            const [key, ...rest] = keyValue.split('=');
            const value = rest.join('=');
            const { POLYCLAUDE_ENV, ensureDirectories } = require('./config');
            ensureDirectories();

            let envContent = '';
            if (fs.existsSync(POLYCLAUDE_ENV)) {
                envContent = fs.readFileSync(POLYCLAUDE_ENV, 'utf8');
                const lines = envContent.split('\n').filter((line: string) => !line.startsWith(`${key}=`));
                envContent = lines.join('\n');
            }
            envContent = envContent.trim() + `\n${key}=${value}\n`;
            fs.writeFileSync(POLYCLAUDE_ENV, envContent.trim() + '\n');
            console.log(`✅ Set ${key} in Polyclaude config.`);
            break;
        }

        case 'reset': {
            const { confirm } = await prompts({
                type: 'confirm',
                name: 'confirm',
                message: '⚠️  This will reset all Polyclaude configuration. Are you sure?',
                initial: false
            });

            if (!confirm) {
                console.log('Cancelled.');
                return;
            }

            const { POLYCLAUDE_DIR } = require('./config');
            // Remove config files but keep the directory
            const files = ['copilot_token.json', 'google_token.json', 'antigravity_token.json', 'aliases.json', '.env'];
            files.forEach(f => {
                const p = require('path').join(POLYCLAUDE_DIR, f);
                if (fs.existsSync(p)) fs.unlinkSync(p);
            });
            console.log('✅ Configuration reset. Run: polyclaude setup');
            break;
        }

        default:
            console.log('Usage: polyclaude config <view|set|reset>');
            console.log('  view   — Show current configuration');
            console.log('  set    — Set a config value (e.g., polyclaude config set KEY=VALUE)');
            console.log('  reset  — Reset all configuration');
            break;
    }
}

async function doRunCommand(args: string[]) {
    // Parse: polyclaude run "prompt" [--model <model>]
    let prompt: string | undefined;
    let modelArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--model' && args[i + 1]) {
            modelArgs.push('--model', resolveAlias(args[i + 1]));
            i++;
        } else if (!prompt) {
            prompt = args[i];
        }
    }

    if (!prompt) {
        console.log('Usage: polyclaude run "<prompt>" [--model <model>]');
        console.log('Example: polyclaude run "fix the bug in auth.ts" --model copilot/gpt-4o');
        process.exit(1);
    }

    // If no model specified, ask user to pick one
    if (modelArgs.length === 0) {
        await doSync(true);
        const selected = await selectModel();
        if (!selected) process.exit(1);
        modelArgs = ['--model', selected];
    } else {
        await doSync(true);
    }

    console.log('🚀 Running one-shot prompt...\n');

    const proxyProcess = await startProxy(false);
    await new Promise(r => setTimeout(r, 500));

    // -p flag runs Claude Code in non-interactive (print) mode
    const claudeArgs = ['-p', prompt, ...modelArgs];
    const exitCode = await runClaude(claudeArgs);

    proxyProcess.kill('SIGTERM');
    process.exit(exitCode || 0);
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    try {
        switch (command) {
            case 'setup': {
                const success = await autoSetup(false);
                if (success) {
                    console.log('\n🎉 Polyclaude is ready to use!');
                }
                process.exit(success ? 0 : 1);
                break;
            }

            case 'login': {
                const provider = args[1];
                await loginFlow(provider);
                console.log('\n🔄 Syncing new configurations...');
                await doSync(true);
                process.exit(0);
                break;
            }

            case 'logout': {
                const provider = args[1];
                await logoutFlow(provider);
                process.exit(0);
                break;
            }

            case 'list': {
                await doSync(true);
                const models = getAvailableModels();
                if (models.length > 0) {
                    console.log('\n🌟 Available Polyclaude Models 🌟');
                    console.log('───────────────────────────────────');
                    models.forEach(m => console.log(` 🚀  ${m}`));
                    console.log('───────────────────────────────────\n');
                    console.log('👉 To use a model, run: polyclaude --model <model-name>');
                } else {
                    console.log('❌ No models available. Run: polyclaude setup');
                }
                process.exit(0);
                break;
            }

            case 'status':
            case 'doctor': {
                await showStatus();
                process.exit(0);
                break;
            }

            case 'run': {
                await doRunCommand(args.slice(1));
                break;
            }

            case 'start':
                await doSync(false);
                console.log('\n🚀 Starting Polyclaude (LiteLLM) Proxy in foreground...');
                await startProxy(true);
                return;

            case 'upgrade':
            case 'update': {
                await doUpgrade();
                process.exit(0);
                break;
            }

            case 'config': {
                await doConfigCommand(args.slice(1));
                process.exit(0);
                break;
            }

            case 'alias': {
                await aliasCommand(args.slice(1));
                process.exit(0);
                break;
            }

            case 'stats': {
                console.log('\n📊 Usage Statistics\n');
                console.log('ℹ️  Cost tracking requires the LiteLLM proxy to be running.');
                console.log('   Start it with: polyclaude start');
                console.log('\n   Then visit: http://localhost:4000/spend/logs');
                console.log('   Or use the LiteLLM UI: http://localhost:4000/ui\n');
                process.exit(0);
                break;
            }

            case 'help':
            case '--help':
            case '-h':
                showHelp();
                process.exit(0);
                break;

            case 'version':
            case '--version':
            case '-v':
                console.log(`Polyclaude v${VERSION}`);
                process.exit(0);
                break;

            default: {
                // Reject unknown bare-word commands
                if (command && !command.startsWith('-')) {
                    console.log(`❌ Unknown command: ${command}`);
                    console.log('   Run "polyclaude help" to see available commands.');
                    process.exit(1);
                }

                // Check dependencies on first run
                const { ok, missing } = checkDependencies();
                if (!ok) {
                    console.log(`\n⚠️  Missing dependencies: ${missing.join(', ')}`);
                    console.log('   Running first-time setup...\n');
                    const success = await autoSetup(false);
                    if (!success) process.exit(1);
                }

                // Always sync first (needed for model list)
                await doSync(true);

                // Resolve aliases in --model flag
                const resolvedArgs = resolveModelArg([...args]);

                // If no --model flag, show interactive model picker
                if (!resolvedArgs.includes('--model')) {
                    const selectedModel = await selectModel();
                    if (!selectedModel) {
                        process.exit(1);
                    }
                    resolvedArgs.push('--model', selectedModel);
                }

                if (!resolvedArgs.includes('--quiet')) {
                    console.log('🚀 Starting Polyclaude Wrapper...');
                }

                const proxyProcess = await startProxy(false);
                await new Promise(r => setTimeout(r, 500));
                const exitCode = await runClaude(resolvedArgs);
                proxyProcess.kill('SIGTERM');
                process.exit(exitCode || 0);
                break;
            }
        }
    } catch (err: any) {
        console.error('❌ Polyclaude Fatal Error:', err.message);
        process.exit(1);
    }
}

main();
