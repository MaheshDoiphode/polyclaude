import * as fs from 'fs';
import * as path from 'path';
import { POLYCLAUDE_DIR, ensureDirectories } from './config';

const ALIASES_PATH = path.join(POLYCLAUDE_DIR, 'aliases.json');

function loadAliases(): Record<string, string> {
    ensureDirectories();
    if (!fs.existsSync(ALIASES_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function saveAliases(aliases: Record<string, string>): void {
    ensureDirectories();
    fs.writeFileSync(ALIASES_PATH, JSON.stringify(aliases, null, 2));
}

export function resolveAlias(modelOrAlias: string): string {
    const aliases = loadAliases();
    return aliases[modelOrAlias] || modelOrAlias;
}

export function setAlias(name: string, model: string): void {
    const aliases = loadAliases();
    aliases[name] = model;
    saveAliases(aliases);
    console.log(`✅ Alias set: "${name}" → ${model}`);
}

export function removeAlias(name: string): void {
    const aliases = loadAliases();
    if (!aliases[name]) {
        console.log(`❌ Alias "${name}" not found.`);
        return;
    }
    delete aliases[name];
    saveAliases(aliases);
    console.log(`✅ Alias "${name}" removed.`);
}

export function listAliases(): void {
    const aliases = loadAliases();
    const entries = Object.entries(aliases);

    if (entries.length === 0) {
        console.log('\nℹ️  No model aliases configured.');
        console.log('   Set one with: polyclaude alias set <name> <model>\n');
        return;
    }

    console.log('\n🏷️  Model Aliases');
    console.log('─────────────────────────────────');
    entries.forEach(([alias, model]) => {
        console.log(`  ${alias} → ${model}`);
    });
    console.log('─────────────────────────────────');
    console.log(`\n💡 Usage: polyclaude --model ${entries[0][0]}\n`);
}

export async function aliasCommand(args: string[]): Promise<void> {
    const subcommand = args[0];

    switch (subcommand) {
        case 'set': {
            const name = args[1];
            const model = args[2];
            if (!name || !model) {
                console.log('Usage: polyclaude alias set <name> <model>');
                console.log('Example: polyclaude alias set fast copilot/gpt-4o');
                return;
            }
            setAlias(name, model);
            break;
        }
        case 'remove':
        case 'rm':
        case 'delete': {
            const name = args[1];
            if (!name) {
                console.log('Usage: polyclaude alias remove <name>');
                return;
            }
            removeAlias(name);
            break;
        }
        case 'list':
        case 'ls':
        default:
            listAliases();
            break;
    }
}
