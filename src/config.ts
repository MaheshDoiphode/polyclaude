import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const HOME_DIR = process.env.USERPROFILE || process.env.HOME || '';
export const POLYCLAUDE_DIR = path.join(HOME_DIR, '.polyclaude');
export const LITELLM_DIR = path.join(HOME_DIR, '.litellm');
export const LITELLM_CONFIG = path.join(LITELLM_DIR, 'copilot-config.yaml');
export const LITELLM_ENV = path.join(LITELLM_DIR, '.env');
export const CLAUDE_SETTINGS = path.join(HOME_DIR, '.claude', 'settings.json');

// Google OAuth credentials — loaded from env vars or ~/.litellm/.env
function envVar(key: string): string {
    if (process.env[key]) return process.env[key]!;
    if (fs.existsSync(LITELLM_ENV)) {
        const match = fs.readFileSync(LITELLM_ENV, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
        if (match) return match[1].trim();
    }
    return '';
}
export function getGoogleClientId() { return envVar('GOOGLE_CLIENT_ID'); }
export function getGoogleClientSecret() { return envVar('GOOGLE_CLIENT_SECRET'); }

export function ensureDirectories(): void {
    if (!fs.existsSync(POLYCLAUDE_DIR)) fs.mkdirSync(POLYCLAUDE_DIR, { recursive: true });
    if (!fs.existsSync(LITELLM_DIR)) fs.mkdirSync(LITELLM_DIR, { recursive: true });
}

export function getProviderKeys(): Record<string, string> {
    ensureDirectories();
    const providerKeys: Record<string, string> = {};

    // Read from LiteLLM .env if user previously placed keys there manually
    if (fs.existsSync(LITELLM_ENV)) {
        const envContent = fs.readFileSync(LITELLM_ENV, 'utf8');
        envContent.split('\n').forEach(line => {
            if (line.includes('=')) {
                const parts = line.split('=');
                const key = parts[0]?.trim();
                const value = parts.slice(1).join('=').trim(); // handle equals signs inside token values just in case
                if (key && key !== 'LITELLM_MASTER_KEY' && key !== 'LITELLM_SALT_KEY' && key !== 'PYTHONUTF8') {
                    providerKeys[key] = value;
                }
            }
        });
    }

    // System env vars override .env file
    if (process.env.GEMINI_API_KEY) providerKeys.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (process.env.ANTIGRAVITY_API_KEY) providerKeys.ANTIGRAVITY_API_KEY = process.env.ANTIGRAVITY_API_KEY;
    if (process.env.ANTHROPIC_API_KEY) providerKeys.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

    return providerKeys;
}

export function setupLitellmEnv(): string {
    ensureDirectories();
    let envContent = '';
    let masterKey: string | undefined;

    if (fs.existsSync(LITELLM_ENV)) {
        envContent = fs.readFileSync(LITELLM_ENV, 'utf8');
        const match = envContent.match(/LITELLM_MASTER_KEY=(.*)/);
        if (match) masterKey = match[1];
    }

    if (!masterKey) {
        masterKey = 'sk-litellm-' + crypto.randomUUID();
        const saltKey = 'sk-salt-' + crypto.randomUUID();
        // Append keys carefully ensuring newline
        envContent = envContent.trim() + `\nLITELLM_MASTER_KEY=${masterKey}\nLITELLM_SALT_KEY=${saltKey}\nPYTHONUTF8=1\n`;
        fs.writeFileSync(LITELLM_ENV, envContent.trim() + '\n');
    }

    return masterKey;
}

export function updateClaudeSettings(masterKey: string, proxyPort: number = 4000): void {
    let settings: any = {};
    if (fs.existsSync(CLAUDE_SETTINGS)) {
        settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
    }

    settings.env = settings.env || {};
    settings.env.ANTHROPIC_AUTH_TOKEN = masterKey;
    settings.env.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}`;

    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
}

export function writeLitellmConfig(yamlConfig: string): void {
    fs.writeFileSync(LITELLM_CONFIG, yamlConfig);
}
