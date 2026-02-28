#!/usr/bin/env node
import { doSync, REQUIRED_FALLBACK_MAPPINGS } from './sync';
import { startProxy, runClaude } from './proxy';
import { loginFlow, logoutFlow } from './auth';
import { LITELLM_CONFIG } from './config';
import * as fs from 'fs';
import prompts from 'prompts';

const VERSION = require('../package.json').version;

function showHelp() {
    console.log(`
  Polyclaude v${VERSION} — Universal multi-provider proxy for Claude Code

  USAGE
    polyclaude                         Launch with interactive model selection
    polyclaude --model <model>         Launch with a specific model
    polyclaude <command> [options]     Run a command

  COMMANDS
    login [provider]    Authenticate with a provider (copilot, antigravity, gemini, anthropic)
    logout [provider]   Remove credentials for a provider
    list                List all available models
    setup               Sync models and configurations
    start               Start the LiteLLM proxy in foreground
    help                Show this help message
    version             Show version

  FLAGS
    --model <name>      Specify model to use with Claude Code
    --quiet             Suppress startup messages

  EXAMPLES
    polyclaude login copilot              Login to GitHub Copilot
    polyclaude login antigravity          Login to Google Antigravity
    polyclaude logout copilot             Logout from GitHub Copilot
    polyclaude --model copilot/gpt-4o     Start with a specific model
    polyclaude list                       Show available models
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

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    try {
        switch (command) {
            case 'setup':
                await doSync(false);
                console.log('\n🎉 Polyclaude Models and Configurations successfully synced!');
                process.exit(0);
                break;

            case 'login': {
                const provider = args[1];
                await loginFlow(provider);
                console.log('\n🔄 Syncing new configurations securely...');
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
                    console.log('-----------------------------------');
                    models.forEach(m => console.log(` 🚀  ${m}`));
                    console.log('-----------------------------------\n');
                    console.log('👉 To use a model, run: polyclaude --model <model-name>');
                } else {
                    console.log('❌ Configurations not generated yet. Run: polyclaude setup');
                }
                process.exit(0);
                break;
            }

            case 'start':
                await doSync(false);
                console.log('\n🚀 Starting Polyclaude (LiteLLM) Proxy in foreground...');
                await startProxy(true);
                return;

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

                // Always sync first (needed for model list)
                await doSync(true);

                // If no --model flag, show interactive model picker
                if (!args.includes('--model')) {
                    const selectedModel = await selectModel();
                    if (!selectedModel) {
                        process.exit(1);
                    }
                    args.push('--model', selectedModel);
                }

                if (!args.includes('--quiet')) {
                    console.log('🚀 Starting Polyclaude Wrapper...');
                }

                const proxyProcess = await startProxy(false);
                await new Promise(r => setTimeout(r, 500));
                const exitCode = await runClaude(args);
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
