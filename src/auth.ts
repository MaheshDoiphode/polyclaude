import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import prompts from 'prompts';
import { POLYCLAUDE_ENV, POLYCLAUDE_DIR, getGoogleClientId, getGoogleClientSecret, ensureDirectories } from './config';

const CUSTOM_TOKEN_PATH = path.join(POLYCLAUDE_DIR, 'copilot_token.json');
export const GOOGLE_TOKEN_PATH = path.join(POLYCLAUDE_DIR, 'google_token.json');

// GitHub Copilot
const COPILOT_CLIENT_ID = "01ab8ac9400c4e429b23";
const GOOGLE_REDIRECT_URI = "http://localhost:51121/oauth-callback";
const GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile"
].join(" ");

interface GoogleTokenResponse {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
}

export async function loginFlow() {
    ensureDirectories();

    const response = await prompts({
        type: 'select',
        name: 'provider',
        message: 'Select a provider to authenticate with Polyclaude:',
        choices: [
            { title: 'GitHub Copilot', value: 'copilot', description: 'Authenticate via Device Link' },
            { title: 'Google Gemini', value: 'gemini', description: 'Authenticate via Google OAuth' },
            { title: 'Google Antigravity', value: 'antigravity', description: 'Authenticate via Google OAuth' },
            { title: 'Anthropic', value: 'anthropic', description: 'Enter Anthropic API Key' }
        ]
    });

    if (!response.provider) {
        console.log('Login cancelled.');
        process.exit(0);
    }

    if (response.provider === 'copilot') {
        await doCopilotAuth();
    } else if (response.provider === 'gemini' || response.provider === 'antigravity') {
        await doGoogleAuth();
    } else {
        await doApiKeyAuth(response.provider);
    }
}

async function doApiKeyAuth(provider: string) {
    const keyResponse = await prompts({
        type: 'password',
        name: 'apiKey',
        message: `Please enter your API Key for ${provider.toUpperCase()}:`,
    });

    if (!keyResponse.apiKey) {
        console.log('Login cancelled.');
        process.exit(0);
    }

    const envKeyMap: Record<string, string> = {
        'anthropic': 'ANTHROPIC_API_KEY'
    };

    const envKey = envKeyMap[provider];
    saveEnvVar(envKey, keyResponse.apiKey);
    console.log(`✅ Successfully saved ${envKey} to Polyclaude config!`);
}

function saveEnvVar(key: string, value: string) {
    let envContent = '';
    if (fs.existsSync(POLYCLAUDE_ENV)) {
        envContent = fs.readFileSync(POLYCLAUDE_ENV, 'utf8');
        const lines = envContent.split('\n').filter(line => !line.startsWith(`${key}=`));
        envContent = lines.join('\n');
    }
    envContent = envContent.trim() + `\n${key}=${value}\n`;
    fs.writeFileSync(POLYCLAUDE_ENV, envContent.trim() + '\n');
}

// ============================================
// Google OAuth Flow
// ============================================

function base64URLEncode(str: Buffer): string {
    return str.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function generatePKCE() {
    const verifier = base64URLEncode(crypto.randomBytes(32));
    const challenge = base64URLEncode(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

async function doGoogleAuth() {
    console.log('\n⏳ Initiating Google Desktop Authentication...');

    // Ensure Google OAuth app credentials are configured
    if (!getGoogleClientId() || !getGoogleClientSecret()) {
        console.log('\n📋 Google OAuth app credentials not found.');
        console.log('   Create one at: https://console.cloud.google.com/apis/credentials');
        console.log('   Application type: Desktop app\n');

        const clientId = await prompts({
            type: 'text',
            name: 'value',
            message: 'Google OAuth Client ID:'
        });
        if (!clientId.value) { console.log('❌ Cancelled.'); return; }

        const clientSecret = await prompts({
            type: 'text',
            name: 'value',
            message: 'Google OAuth Client Secret:'
        });
        if (!clientSecret.value) { console.log('❌ Cancelled.'); return; }

        // Save to .env
        saveEnvVar('GOOGLE_CLIENT_ID', clientId.value.trim());
        saveEnvVar('GOOGLE_CLIENT_SECRET', clientSecret.value.trim());
    }

    const { verifier, challenge } = generatePKCE();

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", getGoogleClientId());
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
    authUrl.searchParams.set("scope", GOOGLE_SCOPES);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

    console.log('\n=========================================');
    console.log(`🔗 Please visit this URL to securely login with Google:\n\n${authUrl.toString()}\n`);
    console.log('=========================================\n');

    let code: string | undefined;

    // Try starting a local server to catch the redirect
    try {
        const express = require('express');
        const app = express();
        const server = app.listen(51121);

        console.log('Waiting for approval in browser... (This may take a minute)');
        console.log('If browser redirect fails, close the browser and paste the returned localhost URL here.');

        code = await new Promise<string | undefined>((resolve) => {
            // Setup manual fallback timeout (give them 2 seconds to paste if redirect failed)
            const promptFallback = async () => {
                const manual = await prompts({
                    type: 'text',
                    name: 'uri',
                    message: 'Paste the redirected localhost URL or code here:'
                });
                if (manual.uri) {
                    try {
                        const parsed = new URL(manual.uri);
                        const codeParam = parsed.searchParams.get('code');
                        resolve(codeParam || manual.uri);
                    } catch (e) {
                        resolve(manual.uri); // might be raw code
                    }
                } else {
                    resolve(undefined);
                }
            };

            // Non-blocking prompt
            promptFallback();

            app.get('/oauth-callback', (req: any, res: any) => {
                const c = req.query.code;
                res.send('<h1>Authentication successful!</h1><p>You can securely close this window and return to your terminal.</p>');
                resolve(c);
            });
        });

        server.close();
        // Clear terminal stdin if user hit enter without pasting
        process.stdin.resume();

    } catch (e) {
        // Fallback exclusively to manual if port bind fails
        const manual = await prompts({
            type: 'text',
            name: 'uri',
            message: 'Local server failed. Paste the redirected localhost URL or code here:'
        });

        try {
            const parsed = new URL(manual.uri);
            code = parsed.searchParams.get('code') || manual.uri;
        } catch (_) {
            code = manual.uri;
        }
    }

    if (!code) {
        console.log('❌ Failed to retrieve authorization code.');
        process.exit(1);
    }

    // Exchange Code for Token
    try {
        const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                client_id: getGoogleClientId(),
                client_secret: getGoogleClientSecret(),
                code,
                grant_type: "authorization_code",
                redirect_uri: GOOGLE_REDIRECT_URI,
                code_verifier: verifier,
            }).toString(),
        });

        if (!tokenResponse.ok) {
            console.error('❌ Failed to exchange Google OAuth code:', await tokenResponse.text());
            process.exit(1);
        }

        const tokenData = await tokenResponse.json() as GoogleTokenResponse;

        fs.writeFileSync(GOOGLE_TOKEN_PATH, JSON.stringify({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at: Date.now() + (tokenData.expires_in * 1000)
        }, null, 2));

        console.log('\n✅ Successfully authenticated with Google!');
        console.log('✅ Refresh Token securely cached for Polyclaude.');

    } catch (e: any) {
        console.error('❌ Error exchanging Google tokens:', e.message);
    }
}

// ============================================
// Copilot Device Auth Flow
// ============================================

async function doCopilotAuth() {
    console.log('\n⏳ Initiating GitHub Device Authentication...');
    try {
        const deviceRes = await fetch('https://github.com/login/device/code', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: 'read:user' })
        });

        if (!deviceRes.ok) throw new Error('Failed to fetch device code');
        const deviceData = await deviceRes.json() as any;

        console.log('\n=========================================');
        console.log(`🔗 Please visit: ${deviceData.verification_uri}`);
        console.log(`🔑 And enter code: ${deviceData.user_code}`);
        console.log('=========================================\n');
        console.log('Waiting for approval in browser... (This may take a minute)');

        let interval = deviceData.interval * 1000;

        while (true) {
            await new Promise(r => setTimeout(r, interval + 500)); // slight safety margin

            const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: COPILOT_CLIENT_ID,
                    device_code: deviceData.device_code,
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
                })
            });

            if (!tokenRes.ok) continue;

            const tokenData = await tokenRes.json() as any;

            if (tokenData.access_token) {
                fs.writeFileSync(CUSTOM_TOKEN_PATH, JSON.stringify({ oauth_token: tokenData.access_token }, null, 2));
                console.log('✅ Successfully authenticated with GitHub Copilot!');
                console.log('✅ Token securely cached for Polyclaude.');
                break;
            }

            if (tokenData.error === 'authorization_pending') {
                continue;
            }

            if (tokenData.error === 'slow_down') {
                interval += 5000;
                continue;
            }

            if (tokenData.error) {
                console.error(`❌ Authentication failed: ${tokenData.error}`);
                break;
            }
        }
    } catch (e: any) {
        console.error('❌ Error during Copilot Authentication:', e.message);
    }
}

export { CUSTOM_TOKEN_PATH };
