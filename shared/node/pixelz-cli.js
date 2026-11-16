// Spec-driven argument parsing and dispatch shared by the Node CLIs. Node built-ins only, like pixelz-common.js.
// Mirrors the Python CLIs' argparse definitions: the same flags, value types and error wording,
// so an agent sees one contract. Anything unrecognised is rejected: unknown flags used to be
// spread into the request, so a typo like --commnt created a billable job without the comment,
// and a stray --contactAPIkey could override credentials.
const { HEX_COLOR } = require('./pixelz-common.js');

/** @typedef {Record<string, any>} Options parsed flags, keyed by dest */
/** @typedef {{ dest: string, type: 'string' | 'int' | 'float' | 'true-false' | 'bool' }} FlagDef */
/** @typedef {{ positionals: string[], variadic?: boolean, required?: string[], flags: Record<string, FlagDef> }} CommandSpec */

/** @param {string} message */
const fail = message => new Error(`[VALIDATION_ERROR] ${message}`);

/**
 * @param {string} flagName
 * @param {string | null | undefined} value
 */
function requireHex(flagName, value) {
    if (value != null && !HEX_COLOR.test(value)) throw fail(`${flagName} must be a hex colour like #FF5733`);
}

/**
 * Flag names (aliases share `dest`) of one value type.
 * @param {FlagDef['type']} type
 * @param {string} dest
 * @param {string[]} names defaults to [dest]
 */
const flag = (type, dest, ...names) =>
    Object.fromEntries((names.length ? names : [dest]).map(n => [n, { dest, type }]));
/** @param {string[]} names */
const strings = (...names) => Object.assign({}, ...names.map(n => flag('string', n)));

const INT_PATTERN = /^[+-]?\d+$/;
const FLOAT_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Parses and type-checks one command's arguments.
 * @param {CommandSpec} spec
 * @param {string} cmd
 * @param {string[]} rawArgs
 * @returns {{ positionals: string[], options: Options }}
 */
function parseCommandLine(spec, cmd, rawArgs) {
    const usage = (/** @type {string} */ message) => fail(`${cmd}: ${message}`);
    /** @type {string[]} */ const positionals = [];
    /** @type {string[]} */ const unrecognized = [];
    /** @type {Options} */ const options = {};
    let onlyPositionals = false;
    for (let i = 0; i < rawArgs.length; i++) {
        const token = rawArgs[i];
        if (!onlyPositionals && token === '--') { onlyPositionals = true; continue; }
        if (onlyPositionals || !token.startsWith('--')) {
            if (positionals.length < spec.positionals.length || spec.variadic) positionals.push(token);
            else unrecognized.push(token);
            continue;
        }
        const eq = token.indexOf('=');
        const name = token.slice(2, eq === -1 ? undefined : eq);
        const def = Object.hasOwn(spec.flags, name) ? spec.flags[name] : undefined;
        if (!def) { unrecognized.push(token); continue; }
        const label = Object.keys(spec.flags).filter(k => spec.flags[k].dest === def.dest).map(k => `--${k}`).join('/');
        let value;
        if (def.type === 'bool') {
            if (eq !== -1) throw usage(`argument ${label}: ignored explicit argument '${token.slice(eq + 1)}'`);
            options[def.dest] = true;
            continue;
        }
        if (eq !== -1) value = token.slice(eq + 1);
        else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) value = rawArgs[++i];
        else throw usage(`argument ${label}: expected one argument`);
        if (def.type === 'int') {
            if (!INT_PATTERN.test(value.trim()) || !Number.isSafeInteger(Number(value))) throw usage(`argument ${label}: invalid int value: '${value}'`);
            options[def.dest] = Number(value);
        } else if (def.type === 'float') {
            if (!FLOAT_PATTERN.test(value.trim()) || !Number.isFinite(Number(value))) throw usage(`argument ${label}: invalid float value: '${value}'`);
            options[def.dest] = Number(value);
        } else if (def.type === 'true-false') {
            if (value !== 'true' && value !== 'false') throw usage(`argument ${label}: invalid choice: '${value}' (choose from 'true', 'false')`);
            options[def.dest] = value;
        } else {
            options[def.dest] = value;
        }
    }
    // An empty positional is as good as a missing one: it would reach the API as nothing at all.
    // Positionals are reported before required flags, as argparse does, so both CLIs word it alike.
    const missingPositionals = spec.positionals
        .filter((_, i) => !positionals[i] || (spec.variadic && positionals.some(p => !p))).map(n => `<${n}>`);
    if (missingPositionals.length) throw fail(`${cmd} requires ${missingPositionals.join(', ')}`);
    const missingFlags = (spec.required || []).filter(n => !options[n]).map(n => `--${n}`);
    if (missingFlags.length) throw fail(`${cmd} requires ${missingFlags.join(', ')}`);
    if (unrecognized.length) throw usage(`unrecognized arguments: ${unrecognized.join(' ')}`);
    return { positionals, options };
}

/**
 * Entry point of a CLI: prints usage, rejects unknown commands, then parses the arguments and runs the command.
 * @param {{
 *   usage: string,
 *   specs: Record<string, CommandSpec>,
 *   commands: Record<string, (positionals: string[], options: Options) => Promise<void>>,
 *   onError: (err: any, cmd: string) => void,
 * }} cfg onError reports a failed command and sets the exit code
 */
function runCli({ usage, specs, commands, onError }) {
    const [cmd, ...args] = process.argv.slice(2);
    if (cmd === undefined || cmd === '--help' || cmd === '-h') {
        console.log(usage);
    } else if (!Object.hasOwn(commands, cmd)) {
        // Not stdout/exit 0: an agent would read that as success.
        console.error(`[VALIDATION_ERROR] unknown command '${cmd}'\n\n${usage}`);
        process.exitCode = 2;
    } else if (args.includes('--help') || args.includes('-h')) {
        console.log(usage);
    } else {
        (async () => {
            try {
                const { positionals, options } = parseCommandLine(specs[cmd], cmd, args);
                await commands[cmd](positionals, options);
            } catch (err) {
                onError(err, cmd);
            }
        })();
    }
}

// Shorthand-only on purpose, as in pixelz-common.js.
module.exports = { fail, requireHex, flag, strings, parseCommandLine, runCli };
