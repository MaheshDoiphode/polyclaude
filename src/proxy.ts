import { spawn, ChildProcess } from 'child_process';
import { LITELLM_CONFIG, LITELLM_ENV } from './config';
import * as fs from 'fs';
import { startAntigravityProxy } from './antigravity-proxy';

function getEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1' };
    if (fs.existsSync(LITELLM_ENV)) {
        const lines = fs.readFileSync(LITELLM_ENV, 'utf8').split('\n');
        for (const line of lines) {
            if (line.includes('=')) {
                const parts = line.split('=');
                const k = parts[0]?.trim();
                const v = parts.slice(1).join('=').trim();
                if (k) env[k] = v;
            }
        }
    }
    return env;
}

export function startProxy(foreground: boolean = false): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        // Start the Antigravity Interceptor concurrently
        startAntigravityProxy().catch(e => console.error("Could not start Antigravity Interceptor:", e));

        const env = getEnv();

        const litellm = spawn('litellm', ['--config', LITELLM_CONFIG], {
            env,
            shell: true,
            stdio: foreground ? 'inherit' : 'pipe'
        });

        if (!foreground) {
            let started = false;
            // Listen for the "Uvicorn running on" line to know it's ready
            litellm.stdout?.on('data', (data: Buffer) => {
                if (!started && data.toString().includes('Uvicorn running on')) {
                    started = true;
                    resolve(litellm);
                }
            });

            litellm.stderr?.on('data', (data: Buffer) => {
                if (!started && data.toString().includes('Uvicorn running on')) {
                    started = true;
                    resolve(litellm);
                }
            });

            // Failsafe: if it takes longer than 3 seconds without throwing, assume it's running
            setTimeout(() => {
                if (!started) {
                    started = true;
                    resolve(litellm);
                }
            }, 3000);
        }

        litellm.on('error', (err: Error) => {
            console.error('❌ Failed to start LiteLLM Proxy. Please make sure litellm is installed (`pip install "litellm[proxy]"`).');
            if (foreground) process.exit(1);
            else reject(err);
        });

        litellm.on('close', (code: number | null) => {
            if (foreground) {
                console.log(`LiteLLM proxy exited with code ${code}`);
                process.exit(code || 0);
            }
        });

        if (foreground) {
            resolve(litellm);
        }
    });
}

export function runClaude(args: string[]): Promise<number | null> {
    return new Promise((resolve) => {
        const claude = spawn('claude', args, {
            stdio: 'inherit',
            shell: true
        });

        claude.on('close', (code: number | null) => {
            resolve(code);
        });

        claude.on('error', (err: Error) => {
            console.error('❌ Failed to start Claude Code. Ensure `claude` is installed and in your PATH.');
            resolve(1);
        });
    });
}
