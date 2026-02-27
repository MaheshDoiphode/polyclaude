#!/usr/bin/env node
import { doSync } from './sync';
import { startProxy, runClaude } from './proxy';
import { loginFlow } from './auth';
import { LITELLM_CONFIG } from './config';
import * as fs from 'fs';

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    try {
        if (command === 'setup') {
            await doSync(false);
            console.log('\n🎉 Polyclaude Models and Configurations successfully synced!');
            process.exit(0);
        }

        if (command === 'login') {
            await loginFlow();
            console.log('\n🔄 Syncing new configurations securely...');
            await doSync(true);
            process.exit(0);
        }

        if (command === 'list') {
            await doSync(true); // Quiet sync first
            if (fs.existsSync(LITELLM_CONFIG)) {
                const configStr = fs.readFileSync(LITELLM_CONFIG, 'utf8');
                console.log('\n🌟 Available Polyclaude Models 🌟');
                console.log('-----------------------------------');
                const lines = configStr.split('\n');
                lines.forEach(line => {
                    const match = line.match(/- model_name:\s*(.*)/);
                    if (match) {
                        const model = match[1]?.trim();
                        if (model && !['claude-3-5-sonnet-20241022', 'claude-sonnet-4-5-20250929', 'claude-opus-4', 'claude-sonnet-4', 'grok-code-fast-1'].includes(model)) {
                            console.log(` 🚀  ${model}`);
                        }
                    }
                });
                console.log('-----------------------------------\n');
                console.log('👉 To use a custom model, run: polyclaude --model <model-name>');
            } else {
                console.log('❌ Configurations not generated yet. Run: polyclaude setup');
            }
            process.exit(0);
        }

        if (command === 'start') {
            await doSync(false); // Sync visibly
            console.log('\n🚀 Starting Polyclaude (LiteLLM) Proxy in foreground...');
            await startProxy(true); // Blocks foreground
            return;
        }

        // Default behavior: Polyclaude wrapper
        if (!args.includes('--quiet')) {
            console.log('🚀 Starting Polyclaude Wrapper...');
        }

        // Always sync silently before wrapping
        await doSync(true);

        // Start Proxy in background
        const proxyProcess = await startProxy(false);

        // Wait a slight moment for proxy to fully bind ports
        await new Promise(r => setTimeout(r, 500));

        // Launch Claude Code
        const exitCode = await runClaude(args);

        // Cleanup trailing proxy
        proxyProcess.kill('SIGTERM');
        process.exit(exitCode || 0);

    } catch (err: any) {
        console.error('❌ Polyclaude Fatal Error:', err.message);
        process.exit(1);
    }
}

main();
