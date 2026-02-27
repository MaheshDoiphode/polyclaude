import express from 'express';
import crypto from 'crypto';

const ANTIGRAVITY_VERSION = "1.19.6";
const ANTIGRAVITY_HOST = "cloudcode-pa.googleapis.com";
const ANTIGRAVITY_BASE = `https://${ANTIGRAVITY_HOST}/v1internal`;

/**
 * Antigravity Proxy Interceptor
 * 
 * LiteLLM routes "antigravity/*" models to "gemini/*", which formats payloads cleanly.
 * This proxy wraps the payload in the cloudcode envelope and unwraps the response.
 * 
 * Two Google endpoints exist:
 *   - cloudcode-pa.googleapis.com     (primary — both GeminiCLI and Antigravity IDE)
 *   - daily-cloudcode-pa.googleapis.com (alternative/daily builds)
 * 
 * We use the Antigravity endpoint with matching headers.
 * Response SSE events come wrapped as {"response":{...}} and must be unwrapped
 * to bare Gemini format {"candidates":[...]} for LiteLLM.
 */

function generateRequestId() {
    const id = crypto.randomUUID();
    return `projects/p/locations/us-central1/trajectories/${id}`;
}

// Map common shorthand model names to what the API actually expects
const MODEL_MAP: Record<string, string> = {
    'gemini-3.1-pro': 'gemini-3.1-pro-low',
    'gemini-3-pro': 'gemini-3-pro-low',
    'gemini-2.5-flash-thinking': 'gemini-2.5-flash',
    'antigravity-latest': 'gemini-3.1-pro-low',
};

// Keys that should be integers in JSON Schema but may arrive as strings
const NUMERIC_SCHEMA_KEYS = new Set([
    'maxLength', 'minLength', 'maxItems', 'minItems', 'minimum', 'maximum',
    'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'
]);

// Keys that Anthropic's Claude API rejects in tool input_schema
// (not valid in their subset of JSON Schema draft 2020-12)
const DISALLOWED_SCHEMA_KEYS = new Set([
    '$schema', 'default', '$defs', '$ref', 'format',
    'additionalProperties', '$id', '$comment', 'examples',
    'readOnly', 'writeOnly', 'deprecated', '$anchor',
    '$dynamicRef', '$dynamicAnchor', 'contentEncoding',
    'contentMediaType', 'contentSchema', 'if', 'then', 'else',
    'dependentRequired', 'dependentSchemas', 'unevaluatedItems',
    'unevaluatedProperties', 'title'
]);

function sanitizeSchema(obj: any, isClaudeModel: boolean = false): any {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(v => sanitizeSchema(v, isClaudeModel));
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
        // Strip keys that Anthropic rejects for Claude models
        if (isClaudeModel && DISALLOWED_SCHEMA_KEYS.has(k)) continue;
        if (NUMERIC_SCHEMA_KEYS.has(k) && typeof v === 'string') {
            const n = Number(v);
            out[k] = Number.isNaN(n) ? v : n;
        } else {
            out[k] = sanitizeSchema(v, isClaudeModel);
        }
    }
    // Ensure schemas with "properties" have a "type" field
    if (out.properties && !out.type) out.type = 'object';
    // Ensure input_schema has a type
    if (out.input_schema && typeof out.input_schema === 'object' && !out.input_schema.type) {
        out.input_schema.type = 'object';
    }
    // Ensure parameters has a type
    if (out.parameters && typeof out.parameters === 'object' && !out.parameters.type) {
        out.parameters.type = 'object';
    }
    // Resolve anyOf/oneOf wrapping (common from Zod unions and optional fields)
    // Cloudcode's Gemini→Claude conversion may not handle anyOf in function declarations
    if (isClaudeModel && out.anyOf && Array.isArray(out.anyOf)) {
        const nonNull = out.anyOf.filter((s: any) => s.type !== 'null');
        if (nonNull.length >= 1) {
            // Pick the first non-null alternative (most specific)
            const resolved = nonNull[0];
            delete out.anyOf;
            Object.assign(out, resolved);
        }
    }
    if (isClaudeModel && out.oneOf && Array.isArray(out.oneOf)) {
        const nonNull = out.oneOf.filter((s: any) => s.type !== 'null');
        if (nonNull.length >= 1) {
            const resolved = nonNull[0];
            delete out.oneOf;
            Object.assign(out, resolved);
        }
    }
    return out;
}

export function startAntigravityProxy(port: number = 51122): Promise<void> {
    return new Promise((resolve, reject) => {
        const app = express();

        app.use(express.json({ limit: '50mb' }));

        app.use(async (req, res, next) => {
            if (req.method !== 'POST') return next();

            // LiteLLM sends x-goog-api-key (not Authorization) for gemini/ models with custom api_base
            const xGoogKey = req.headers['x-goog-api-key'] as string | undefined;
            const authHeader = req.headers['authorization'] as string | undefined;
            const rawToken = xGoogKey || (authHeader ? authHeader.replace(/^Bearer\s+/i, '') : undefined);
            if (!rawToken) {
                return res.status(401).json({ error: "Missing Authorization header or x-goog-api-key" });
            }

            try {
                // Extract the model from URL or body
                let model = 'gemini-3.1-pro-low';
                const match = req.url.match(/models\/([^:]+):/);
                if (match && match[1]) {
                    model = match[1];
                } else if (req.body?.model) {
                    model = req.body.model;
                }
                // Resolve shorthand names to API-valid model names
                model = MODEL_MAP[model] || model;

                // Sanitize tool parameter schemas
                const body = req.body;
                const isClaude = model.includes('claude');
                if (body?.tools) {
                    body.tools = sanitizeSchema(body.tools, isClaude);
                }

                // Wrap the standard Gemini payload into the Antigravity cloudcode envelope
                const wrapper = {
                    project: "rising-fact-p41fc",
                    model,
                    requestType: "agent",
                    userAgent: "antigravity",
                    requestId: generateRequestId(),
                    request: body
                };

                const isStream = req.url.includes('streamGenerateContent') || req.body?.stream === true;
                const action = isStream ? 'streamGenerateContent' : 'generateContent';
                const alt = isStream ? '?alt=sse' : '';
                const targetUrl = `${ANTIGRAVITY_BASE}:${action}${alt}`;

                const result = await fetch(targetUrl, {
                    method: 'POST',
                    headers: {
                        'Host': ANTIGRAVITY_HOST,
                        'Authorization': `Bearer ${rawToken}`,
                        'Content-Type': 'application/json',
                        'User-Agent': `antigravity/${ANTIGRAVITY_VERSION} windows/amd64`,
                        'Client-Metadata': 'ideType=VSCODE,platform=WINDOWS,pluginType=GEMINI,osVersion=10.0,arch=x64',
                        'Accept-Encoding': 'identity'
                    },
                    body: JSON.stringify(wrapper)
                });

                if (!result.body) {
                    res.status(result.status).end();
                    return;
                }

                // For non-streaming responses, unwrap {"response": {...}} → bare content
                if (!isStream) {
                    const text = await result.text();
                    try {
                        const parsed = JSON.parse(text);
                        const unwrapped = parsed.response || parsed;
                        res.status(result.status).json(unwrapped);
                    } catch {
                        res.status(result.status).send(text);
                    }
                    return;
                }

                // Streaming: unwrap each SSE "data: {...}" line
                // Google sends: data: {"response":{"candidates":[...],...}}
                // LiteLLM expects: data: {"candidates":[...],...}
                res.status(result.status);
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                // @ts-ignore
                const reader = result.body.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();
                let buffer = '';

                const pump = async () => {
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            buffer += decoder.decode(value, { stream: true });

                            // Process complete lines
                            let newlineIdx: number;
                            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                                const line = buffer.substring(0, newlineIdx).trimEnd();
                                buffer = buffer.substring(newlineIdx + 1);

                                if (!line.startsWith('data: ')) {
                                    // Pass through empty lines and other SSE fields
                                    res.write(line + '\n');
                                    continue;
                                }

                                const jsonStr = line.substring(6);
                                try {
                                    const parsed = JSON.parse(jsonStr);
                                    // Unwrap the {"response": {...}} envelope
                                    const unwrapped = parsed.response || parsed;
                                    res.write('data: ' + JSON.stringify(unwrapped) + '\n');
                                } catch {
                                    // Not valid JSON, pass through as-is
                                    res.write(line + '\n');
                                }
                            }
                        }
                        // Flush any remaining buffer
                        if (buffer.trim()) {
                            if (buffer.startsWith('data: ')) {
                                try {
                                    const parsed = JSON.parse(buffer.substring(6));
                                    const unwrapped = parsed.response || parsed;
                                    res.write('data: ' + JSON.stringify(unwrapped) + '\n');
                                } catch {
                                    res.write(buffer);
                                }
                            } else {
                                res.write(buffer);
                            }
                        }
                        res.end();
                    } catch (e) {
                        console.error("[Antigravity] Stream error:", e);
                        res.end();
                    }
                };
                pump();

            } catch (err) {
                console.error("[Antigravity] Error:", err);
                res.status(500).json({ error: "Antigravity Interceptor Failed" });
            }
        });

        app.listen(port, '127.0.0.1', () => {
            console.log(`[Polyclaude] Antigravity Interceptor listening on 127.0.0.1:${port}`);
            resolve();
        }).on('error', reject);
    });
}
