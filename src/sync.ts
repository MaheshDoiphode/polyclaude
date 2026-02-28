import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { HOME_DIR, getGoogleClientId, getGoogleClientSecret, getProviderKeys, setupLitellmEnv, updateClaudeSettings, writeLitellmConfig } from './config';
import { CUSTOM_TOKEN_PATH, GOOGLE_TOKEN_PATH, ANTIGRAVITY_TOKEN_PATH } from './auth';

const COPILOT_APPS_JSON = path.join(HOME_DIR, 'AppData', 'Local', 'github-copilot', 'apps.json');

export const REQUIRED_FALLBACK_MAPPINGS = [
    'claude-3-5-sonnet-20241022',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4',
    'claude-sonnet-4',
    'grok-code-fast-1'
];

interface CopilotModel {
    id: string;
    [key: string]: any;
}

async function fetchCopilotModels(token: string): Promise<CopilotModel[]> {
    return new Promise((resolve, reject) => {
        const options: https.RequestOptions = {
            hostname: 'api.githubcopilot.com',
            path: '/models',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Editor-Version': 'vscode/1.85.1',
                'User-Agent': 'GitHubCopilotChat/0.11.1'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(data).data);
                    } catch (e) {
                        reject(new Error('Failed to parse Copilot models JSON'));
                    }
                } else {
                    reject(new Error(`Failed to fetch models: ${res.statusCode} ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

function getCopilotToken(): string {
    // 1. Check if user did `polyclaude login` for Copilot manually First
    if (fs.existsSync(CUSTOM_TOKEN_PATH)) {
        const customData = JSON.parse(fs.readFileSync(CUSTOM_TOKEN_PATH, 'utf8'));
        if (customData && customData.oauth_token) return customData.oauth_token;
    }

    // 2. Check VS Code default
    if (!fs.existsSync(COPILOT_APPS_JSON)) {
        throw new Error(`Copilot config not found. Please run 'polyclaude login copilot' to authenticate via your browser, or sign into GitHub Copilot in VS Code.`);
    }

    const data = JSON.parse(fs.readFileSync(COPILOT_APPS_JSON, 'utf8'));
    for (const key in data) {
        if (data[key] && data[key].oauth_token) {
            return data[key].oauth_token;
        }
    }
    throw new Error('No OAuth token found in Copilot apps.json or custom cache. Run polyclaude login.');
}

function generateLitellmConfig(copilotModels: CopilotModel[], providerKeys: Record<string, string>, googleAccessToken?: string, antigravityAccessToken?: string): string {
    let yaml = 'model_list:\n';
    let copilotModelIds = new Set<string>();

    // Add dynamically fetched Copilot models - NAMESPACED!
    copilotModels.forEach(model => {
        yaml += `  - model_name: copilot/${model.id}\n`;
        yaml += `    litellm_params:\n`;
        yaml += `      model: github_copilot/${model.id}\n`;
        yaml += `      extra_headers: {"Editor-Version": "vscode/1.85.1", "Copilot-Integration-Id": "vscode-chat"}\n`;
        copilotModelIds.add(model.id);
    });

    if (providerKeys.ANTIGRAVITY_API_KEY || antigravityAccessToken) {
        yaml += '\n  # Antigravity Models\n';
        const antigravityModels = [
            'gemini-3.1-pro-low',
            'gemini-3.1-pro-high',
            'gemini-3-pro-low',
            'gemini-3-pro-high',
            'gemini-3-flash',
            'gemini-3.1-flash-image',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'claude-sonnet-4-6',
            'claude-opus-4-6-thinking',
            'gpt-oss-120b-medium'
        ];
        antigravityModels.forEach(model => {
            // Keep the CLI alias as antigravity/, but trick LiteLLM into using the Gemini handler internally
            // This prevents LiteLLM from falling back to Anthropic and throwing model errors for 'antigravity/gemini-3.1-pro'
            yaml += `  - model_name: antigravity/${model}\n    litellm_params:\n      model: gemini/${model}\n`;
            if (antigravityAccessToken) {
                yaml += `      api_key: "${antigravityAccessToken}"\n      api_base: "http://127.0.0.1:51122"\n`;
            }
        });
    }

    if (providerKeys.GEMINI_API_KEY || googleAccessToken) {
        yaml += '\n  # Gemini Models\n';
        const geminiModels = [
            'gemini-1.5-pro',
            'gemini-1.5-flash',
            'gemini-2.0-flash',
            'gemini-2.5-flash',
            'gemini-2.5-pro',
            'gemini-3-pro-preview',
            'gemini-3.1-pro-preview',
            'gemini-3-flash-preview'
        ];
        geminiModels.forEach(model => {
            yaml += `  - model_name: gemini/${model}\n    litellm_params:\n      model: gemini/${model}\n`;
            if (googleAccessToken) {
                yaml += `      api_key: "${googleAccessToken}"\n`;
            }
        });
    }

    const bestCopilotModel = copilotModels.find(m => m.id.includes('gpt-4o')) || copilotModels[0];
    const fallbackModel = bestCopilotModel ? bestCopilotModel.id : 'gpt-4o';

    yaml += '\n  # Claude Code Required Fallbacks (Routed to Copilot)\n';
    REQUIRED_FALLBACK_MAPPINGS.forEach(model => {
        if (!copilotModelIds.has(model) && !providerKeys.ANTHROPIC_API_KEY) {
            yaml += `  - model_name: ${model}\n`;
            yaml += `    litellm_params:\n`;
            yaml += `      model: github_copilot/${fallbackModel}\n`;
            yaml += `      extra_headers: {"Editor-Version": "vscode/1.85.1", "Copilot-Integration-Id": "vscode-chat"}\n`;
        }
    });

    yaml += '\nlitellm_settings:\n  drop_params: true\n';
    return yaml;
}

async function readGoogleToken(tokenPath: string, quiet: boolean): Promise<string | undefined> {
    if (!fs.existsSync(tokenPath)) return undefined;

    const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    if (!tokenData?.access_token) return undefined;

    if (Date.now() > tokenData.expires_at && tokenData.refresh_token) {
        // Use client credentials stored in token file, fallback to env config
        const clientId = tokenData.client_id || getGoogleClientId();
        const clientSecret = tokenData.client_secret || getGoogleClientSecret();

        if (!clientId || !clientSecret) {
            if (!quiet) console.log('⚠️  OAuth credentials missing — skipping token refresh. Run: polyclaude login');
            return undefined;
        }
        if (!quiet) console.log('🔄 Refreshing OAuth Token...');

        const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: tokenData.refresh_token,
                grant_type: "refresh_token"
            }).toString()
        });

        if (refreshRes.ok) {
            const newTokens = await refreshRes.json() as any;
            fs.writeFileSync(tokenPath, JSON.stringify({
                access_token: newTokens.access_token,
                refresh_token: tokenData.refresh_token,
                expires_at: Date.now() + (newTokens.expires_in * 1000)
            }, null, 2));
            return newTokens.access_token;
        } else {
            throw new Error(`Failed to refresh token. Please re-login with: polyclaude login`);
        }
    }

    return tokenData.access_token;
}

export async function doSync(quiet: boolean = false): Promise<void> {
    try {
        if (!quiet) console.log('🔄 Polyclaude: Syncing models seamlessly...');
        const token = getCopilotToken();
        const models = await fetchCopilotModels(token);
        const providerKeys = getProviderKeys();

        const googleAccessToken = await readGoogleToken(GOOGLE_TOKEN_PATH, quiet);
        const antigravityAccessToken = await readGoogleToken(ANTIGRAVITY_TOKEN_PATH, quiet);

        const yamlConfig = generateLitellmConfig(models, providerKeys, googleAccessToken, antigravityAccessToken);
        writeLitellmConfig(yamlConfig);

        const masterKey = setupLitellmEnv();
        updateClaudeSettings(masterKey, 4000);

        if (!quiet) {
            let providers = ['Copilot'];
            if (providerKeys.GEMINI_API_KEY) providers.push('Gemini');
            if (providerKeys.ANTIGRAVITY_API_KEY) providers.push('Antigravity');
            if (providerKeys.ANTHROPIC_API_KEY) providers.push('Anthropic');
            console.log(`✅ Synced ${models.length} native models.`);
            console.log(`✅ Loaded multi-provider support for: ${providers.join(', ')}.`);
        }
    } catch (err: any) {
        console.error('❌ Polyclaude Sync Error:', err.message);
        process.exit(1);
    }
}
